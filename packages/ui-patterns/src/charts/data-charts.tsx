/**
 * Gráficos de datos de Reportes: línea pequeña, columnas, cascada, mapa de
 * calor y barra repartida. Son HTML y SVG propios, sin librería, para que cada marca
 * sea un control con su nombre: se recorren con el teclado, dicen su detalle
 * al pasar el mouse o al tocarlas y todos ofrecen «Ver como tabla».
 *
 * Colores: `--series-1..3` para categorías (comprobadas para daltonismo),
 * `--series-muted` para la comparación y `--scale-0..4` para la escala; ver
 * `globals.css`. El color nunca es la única señal: la tabla y el detalle
 * dicen lo mismo con palabras.
 */
import { Button, cn, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@odentia/ui"
import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react"
import { moveInGrid, niceTicks, scaleLevel, sparkPoints, type WaterfallKind, waterfallBars } from "./chart-math.js"

export type SeriesTone = "series-1" | "series-2" | "series-3" | "muted"

const TONE_VAR: Record<SeriesTone, string> = {
  "series-1": "var(--series-1)",
  "series-2": "var(--series-2)",
  "series-3": "var(--series-3)",
  muted: "var(--series-muted)",
}

/** La marca que no está elegida se aclara hacia la tarjeta: sigue leyéndose, pero cede el foco. */
function faded(tone: SeriesTone): string {
  return `color-mix(in oklab, ${TONE_VAR[tone]} 45%, var(--card))`
}

/** Lo que no ocurrió todavía (el mes en curso) va rayado. */
function partialFill(color: string): string {
  return `repeating-linear-gradient(135deg, ${color} 0 5px, color-mix(in oklab, ${color} 55%, var(--card)) 5px 8px)`
}

const SCALE_VAR = ["var(--scale-0)", "var(--scale-1)", "var(--scale-2)", "var(--scale-3)", "var(--scale-4)"] as const

/** Sin dato (cerrado, sin horario): rayado gris, distinto del cero. */
const NO_DATA_FILL = "repeating-linear-gradient(45deg, var(--muted) 0 4px, var(--border) 4px 6px)"

function TableToggle({ asTable, onToggle }: { asTable: boolean; onToggle: () => void }) {
  return (
    <Button type="button" variant="link" className="h-auto min-h-11 p-0 sm:min-h-8" aria-pressed={asTable} onClick={onToggle}>
      {asTable ? "Ver como gráfico" : "Ver como tabla"}
    </Button>
  )
}

// --- Línea pequeña -------------------------------------------------------------------------

/**
 * La tendencia de una cifra en pocos puntos (12 meses): gris, con el último
 * punto en el color de la marca. Es un apoyo; la cifra y su comparación van
 * escritas al lado y `label` dice el recorrido con palabras.
 */
export function Sparkline({
  values,
  label,
  lastPartial = false,
  width = 120,
  height = 36,
  className,
}: {
  values: Array<number | null>
  /** Lo que dibuja, dicho con palabras: «Cobrado en los últimos 12 meses: sube de 38 900 a 48 200». */
  label: string
  /**
   * El último punto todavía corre (el mes en curso): su tramo va punteado y el
   * punto hueco, para que no se lea como una caída.
   */
  lastPartial?: boolean
  width?: number
  height?: number
  className?: string
}) {
  const points = sparkPoints(values, width, height)
  const drawn = points.filter((point): point is { x: number; y: number } => point !== null)
  const last = drawn[drawn.length - 1]
  const tail = lastPartial && points[points.length - 1] ? drawn.slice(-2) : []
  const body = tail.length === 2 ? points.slice(0, -1) : points
  // Un hueco corta la línea en tramos: no se inventa lo que falta.
  const segments: string[] = []
  let current: string[] = []
  for (const point of body) {
    if (point) current.push(`${point.x},${point.y}`)
    else if (current.length > 0) {
      segments.push(current.join(" "))
      current = []
    }
  }
  if (current.length > 0) segments.push(current.join(" "))
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className={cn("shrink-0 overflow-visible", className)}>
      {segments.map((segment) => (
        <polyline key={segment} points={segment} fill="none" stroke="var(--series-muted)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {tail.length === 2 ? (
        <polyline
          points={tail.map((point) => `${point.x},${point.y}`).join(" ")}
          fill="none"
          stroke="var(--series-muted)"
          strokeWidth={2}
          strokeDasharray="3 3"
          strokeLinecap="round"
        />
      ) : null}
      {last ? (
        <circle cx={last.x} cy={last.y} r={4} fill={lastPartial ? "var(--card)" : "var(--primary)"} stroke={lastPartial ? "var(--primary)" : "var(--card)"} strokeWidth={2} />
      ) : null}
    </svg>
  )
}

// --- Columnas ------------------------------------------------------------------------------

export interface ChartCategory {
  key: string
  /** Nombre completo, para el detalle y la tabla: «Septiembre de 2026». */
  label: string
  /** Rótulo bajo la columna: «sep». */
  short: string
  /** Aún no termina (el mes en curso): la columna va rayada y la tabla lo dice. */
  partial?: boolean
}

export interface ColumnSeries {
  key: string
  label: string
  tone: SeriesTone
  values: Array<number | null>
}

export interface ColumnChartProps {
  /** Nombre del gráfico para quien no lo ve; el título visible lo pone la tarjeta. */
  title: string
  categories: ChartCategory[]
  /** Columnas: apiladas (`stacked`) o una al lado de la otra. Hasta tres series. */
  bars: ColumnSeries[]
  stacked?: boolean
  /** Comparación dibujada como línea gris: un año antes, el periodo anterior. */
  line?: Omit<ColumnSeries, "tone">
  /** Una línea de referencia, como la meta. */
  reference?: { value: number; label: string }
  /** El valor escrito entero (tabla, detalle y nombre de cada columna). */
  format: (value: number) => string
  /** El valor del eje, abreviado: «20 mil». */
  axis?: (value: number) => string
  /** Lo que dice el detalle de una columna; por defecto, cada serie con su valor. */
  detail?: (index: number) => ReactNode
  /** Columna elegida al abrir; por defecto, la última. */
  initial?: number
  /** Encabezado de la primera columna de la tabla. */
  tableHeading?: string
  /** Lo que suman las series (lo cobrado que se reparte): la tabla lo escribe como última columna. Se da aparte porque una serie puede ser negativa (un mes con pérdida) y el dibujo no la apila. */
  total?: { label: string; values: Array<number | null> }
  height?: number
  className?: string
}

function sumOf(values: Array<number | null | undefined>): number {
  return values.reduce<number>((total, value) => total + Math.max(0, value ?? 0), 0)
}

/**
 * La misma cifra por mes (o por semana o día): columnas con el eje, la
 * comparación como línea y la meta como referencia. Pasar el mouse, tocar o
 * enfocar una columna la elige y abre su detalle; las flechas recorren las
 * columnas. «Ver como tabla» da los mismos datos escritos.
 */
export function ColumnChart({
  title,
  categories,
  bars,
  stacked = false,
  line,
  reference,
  format,
  axis = format,
  detail,
  initial,
  tableHeading = "Mes",
  total,
  height = 200,
  className,
}: ColumnChartProps) {
  const id = useId()
  const count = categories.length
  const [active, setActive] = useState(() => Math.max(0, Math.min(count - 1, initial ?? count - 1)))
  const [asTable, setAsTable] = useState(false)
  const columns = useRef<Array<HTMLButtonElement | null>>([])
  const at = Math.max(0, Math.min(count - 1, active))

  const columnTotal = (index: number): number =>
    stacked ? sumOf(bars.map((series) => series.values[index])) : Math.max(0, ...bars.map((series) => series.values[index] ?? 0))
  const max = Math.max(
    0,
    ...categories.map((_, index) => columnTotal(index)),
    ...(line?.values.map((value) => value ?? 0) ?? []),
    reference?.value ?? 0,
  )
  const ticks = niceTicks(max)
  const top = ticks[ticks.length - 1] ?? 1
  const percent = (value: number): number => (Math.max(0, value) / top) * 100

  const describe = (index: number): string => {
    const category = categories[index]
    if (!category) return ""
    const parts = bars.map((series) => {
      const value = series.values[index]
      return `${series.label} ${value === null || value === undefined ? "sin datos" : format(value)}`
    })
    const sum = total?.values[index]
    if (total && sum !== null && sum !== undefined) parts.unshift(`${total.label} ${format(sum)}`)
    const previous = line?.values[index]
    if (line && previous !== null && previous !== undefined) parts.push(`${line.label} ${format(previous)}`)
    return `${category.label}${category.partial ? ", hasta hoy" : ""}: ${parts.join(", ")}`
  }

  const choose = (index: number, focus = false): void => {
    setActive(index)
    if (focus) columns.current[index]?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = moveInGrid({ row: 0, column: index }, event.key, 1, count)
    if (!next || next.column === index) return
    event.preventDefault()
    choose(next.column, true)
  }

  const linePoints = line
    ? line.values
        .map((value, index) => (value === null || value === undefined ? null : `${((index + 0.5) / count) * 100},${100 - percent(value)}`))
        .filter((point): point is string => point !== null)
        .join(" ")
    : ""
  const activeTop = percent(Math.max(columnTotal(at), line?.values[at] ?? 0))
  // El detalle se abre sobre la columna y no se sale del gráfico en los bordes;
  // si la columna es alta, va arriba y al costado, sin taparla ni tapar el título.
  const tall = activeTop > 55
  const tipStyle: CSSProperties = tall
    ? { left: `${((at + 0.5) / count) * 100}%`, top: 0, transform: at >= count / 2 ? "translateX(calc(-100% - 16px))" : "translateX(16px)" }
    : {
        left: `${((at + 0.5) / count) * 100}%`,
        bottom: `calc(${activeTop}% + 10px)`,
        transform: at <= 1 ? "translateX(-12px)" : at >= count - 2 ? "translateX(calc(-100% + 12px))" : "translateX(-50%)",
      }
  const gridColumns = `repeat(${count}, minmax(0, 1fr))`

  return (
    <figure className={cn("flex min-w-0 flex-col gap-2", className)} aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`} className="sr-only">
        {title}
      </figcaption>
      {asTable ? (
        <div className="min-w-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{tableHeading}</TableHead>
                {bars.map((series) => (
                  <TableHead key={series.key} scope="col" className="text-right">
                    {series.label}
                  </TableHead>
                ))}
                {line ? (
                  <TableHead scope="col" className="text-right">
                    {line.label}
                  </TableHead>
                ) : null}
                {total ? (
                  <TableHead scope="col" className="text-right">
                    {total.label}
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((category, index) => (
                <TableRow key={category.key}>
                  <TableCell>
                    {category.label}
                    {category.partial ? ", hasta hoy" : ""}
                  </TableCell>
                  {bars.map((series) => {
                    const value = series.values[index]
                    return (
                      <TableCell key={series.key} className="text-right tabular-nums">
                        {value === null || value === undefined ? "Sin datos" : format(value)}
                      </TableCell>
                    )
                  })}
                  {line ? (
                    <TableCell className="text-right tabular-nums">
                      {line.values[index] === null || line.values[index] === undefined ? "Sin datos" : format(line.values[index] ?? 0)}
                    </TableCell>
                  ) : null}
                  {total ? (
                    <TableCell className="text-right font-semibold tabular-nums">
                      {total.values[index] === null || total.values[index] === undefined ? "Sin datos" : format(total.values[index] ?? 0)}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="flex min-w-0 gap-2">
          <div aria-hidden className="relative w-12 shrink-0 text-right text-xs text-muted-foreground" style={{ height }}>
            {ticks.map((tick) => (
              <span key={tick} className="absolute right-0 translate-y-1/2 tabular-nums" style={{ bottom: `${percent(tick)}%` }}>
                {axis(tick)}
              </span>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="relative border-b border-input" style={{ height }}>
              {ticks.slice(1).map((tick) => (
                <div key={tick} aria-hidden className="absolute inset-x-0 border-t border-border" style={{ bottom: `${percent(tick)}%` }} />
              ))}
              {reference ? (
                <>
                  <div aria-hidden className="absolute inset-x-0 h-0.5 bg-series-2" style={{ bottom: `${percent(reference.value)}%` }} />
                  <span
                    aria-hidden
                    className="absolute left-1.5 rounded bg-card px-1 text-xs font-bold text-foreground"
                    style={{ bottom: `calc(${percent(reference.value)}% + 4px)` }}
                  >
                    {reference.label}
                  </span>
                </>
              ) : null}
              {line && linePoints ? (
                <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
                  <polyline points={linePoints} fill="none" stroke="var(--series-muted)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                </svg>
              ) : null}
              <div className="absolute inset-0 grid" style={{ gridTemplateColumns: gridColumns }}>
                {categories.map((category, index) => {
                  const chosen = index === at
                  let stackBottom = 0
                  return (
                    <button
                      key={category.key}
                      ref={(element) => {
                        columns.current[index] = element
                      }}
                      type="button"
                      tabIndex={chosen ? 0 : -1}
                      aria-label={describe(index)}
                      aria-pressed={chosen}
                      onMouseEnter={() => choose(index)}
                      onFocus={() => choose(index)}
                      onClick={() => choose(index)}
                      onKeyDown={(event) => onKeyDown(event, index)}
                      className="relative flex h-full min-w-0 items-end justify-center gap-0.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {stacked ? (
                        <span className="relative h-full w-full max-w-7">
                          {bars.map((series) => {
                            const value = Math.max(0, series.values[index] ?? 0)
                            const style: CSSProperties = {
                              bottom: `${stackBottom}%`,
                              height: `${percent(value)}%`,
                              background: category.partial ? partialFill(chosen ? TONE_VAR[series.tone] : faded(series.tone)) : chosen ? TONE_VAR[series.tone] : faded(series.tone),
                            }
                            stackBottom += percent(value)
                            return value > 0 ? <span key={series.key} className="absolute inset-x-0" style={style} /> : null
                          })}
                        </span>
                      ) : (
                        bars.map((series) => {
                          const value = Math.max(0, series.values[index] ?? 0)
                          const color = chosen ? TONE_VAR[series.tone] : faded(series.tone)
                          return (
                            <span
                              key={series.key}
                              className={cn("block rounded-t", bars.length > 1 ? "w-3 sm:w-3.5" : "w-full max-w-7")}
                              style={{ height: `${percent(value)}%`, background: category.partial ? partialFill(color) : color }}
                            />
                          )
                        })
                      )}
                    </button>
                  )
                })}
              </div>
              {count > 0 ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute z-10 flex flex-col gap-0.5 whitespace-nowrap rounded-lg bg-foreground px-3 py-2 text-xs text-background shadow-lg"
                  style={tipStyle}
                >
                  {detail ? (
                    detail(at)
                  ) : (
                    <>
                      <strong className="text-[13px]">
                        {categories[at]?.label}
                        {categories[at]?.partial ? ", hasta hoy" : ""}
                      </strong>
                      {bars.map((series) => {
                        const value = series.values[at]
                        return (
                          <span key={series.key}>
                            {series.label}: {value === null || value === undefined ? "sin datos" : format(value)}
                          </span>
                        )
                      })}
                      {line && line.values[at] !== null && line.values[at] !== undefined ? (
                        <span className="opacity-80">
                          {line.label}: {format(line.values[at] ?? 0)}
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </div>
            <div aria-hidden className="grid text-center text-xs text-muted-foreground" style={{ gridTemplateColumns: gridColumns }}>
              {categories.map((category, index) => (
                <span key={category.key} className={cn("truncate", index === at && "font-bold text-foreground")}>
                  {category.short}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        {!asTable && (bars.length > 1 || line || reference) ? (
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
            {bars.length > 1 || line
              ? bars.map((series) => (
                  <li key={series.key} className="flex items-center gap-1.5">
                    <span aria-hidden className="size-3 rounded-[3px]" style={{ background: TONE_VAR[series.tone] }} />
                    {series.label}
                  </li>
                ))
              : null}
            {line ? (
              <li className="flex items-center gap-1.5">
                <span aria-hidden className="h-0.5 w-4 bg-series-muted" />
                {line.label}
              </li>
            ) : null}
            {reference ? (
              <li className="flex items-center gap-1.5">
                <span aria-hidden className="h-0.5 w-4 bg-series-2" />
                {reference.label}
              </li>
            ) : null}
          </ul>
        ) : (
          <span />
        )}
        <TableToggle asTable={asTable} onToggle={() => setAsTable((value) => !value)} />
      </div>
    </figure>
  )
}

// --- Cascada -------------------------------------------------------------------------------

export interface WaterfallStep {
  key: string
  /** Rótulo bajo la barra: «Comisiones». */
  label: string
  /** Importe positivo; el resultado puede ser negativo. */
  value: number
  /** `total` sube desde cero, `less` resta de lo que quedaba y `result` es lo que queda. */
  kind: WaterfallKind
  /** Color de la barra; por defecto el total y el resultado van en la serie 1 y las restas en gris. */
  tone?: SeriesTone
}

export interface WaterfallChartProps {
  /** Nombre del gráfico para quien no lo ve; el título visible lo pone la tarjeta. */
  title: string
  steps: WaterfallStep[]
  /** El importe entero (tabla, detalle y nombre de cada barra). */
  format: (value: number) => string
  /** El importe corto sobre la barra y en el eje: «48 200», «20 mil». */
  short?: (value: number) => string
  /** Lo que dice el panel de la barra elegida. */
  detail?: (index: number) => ReactNode
  /** Una columna más en la tabla, como «De cada 100 cobrados». */
  share?: { heading: string; value: (index: number) => string }
  /** Barra elegida al abrir; por defecto, la segunda (lo primero que resta). */
  initial?: number
  height?: number
  className?: string
}

function stepTone(step: WaterfallStep): SeriesTone {
  return step.tone ?? (step.kind === "less" ? "muted" : "series-1")
}

/**
 * De un total a lo que queda, paso a paso: el total sube desde cero, cada
 * resta baja desde donde quedó la anterior y el resultado vuelve a salir de
 * cero. Pasar el mouse, tocar o enfocar una barra la elige y su detalle se lee
 * al lado (región viva); las flechas recorren las barras. «Ver como tabla» da
 * los mismos importes escritos.
 */
export function WaterfallChart({ title, steps, format, short = format, detail, share, initial, height = 260, className }: WaterfallChartProps) {
  const id = useId()
  const count = steps.length
  const [active, setActive] = useState(() => Math.max(0, Math.min(count - 1, initial ?? Math.min(1, count - 1))))
  const [asTable, setAsTable] = useState(false)
  const marks = useRef<Array<HTMLButtonElement | null>>([])
  const at = Math.max(0, Math.min(count - 1, active))
  const { bars, low, high } = waterfallBars(steps)
  const ticks = niceTicks(Math.max(high, -low))
  const top = high > 0 ? (ticks.find((tick) => tick >= high) ?? high) : 0
  const bottom = low < 0 ? -(ticks.find((tick) => tick >= -low) ?? -low) : 0
  const range = top - bottom || 1
  const percent = (value: number): number => ((value - bottom) / range) * 100
  const axisTicks = [...ticks.filter((tick) => tick <= top), ...ticks.filter((tick) => tick > 0 && -tick >= bottom).map((tick) => -tick)]
  // Lo que resta lleva su signo; si es cero, no hay nada que restar. Un paso
  // que resta en negativo suma (una categoría que devolvió más de lo que gastó).
  const lessSign = (step: WaterfallStep): string => (step.kind !== "less" || step.value === 0 ? "" : step.value < 0 ? "+" : "−")
  const signed = (step: WaterfallStep): string => `${lessSign(step)}${short(step.kind === "less" ? Math.abs(step.value) : step.value)}`
  const describe = (index: number): string => {
    const step = steps[index]
    if (!step) return ""
    if (step.kind !== "less" || step.value === 0) return `${step.label}: ${format(step.value)}`
    return `${step.label}: ${step.value < 0 ? "más" : "menos"} ${format(Math.abs(step.value))}`
  }
  const choose = (index: number, focus = false): void => {
    setActive(index)
    if (focus) marks.current[index]?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = moveInGrid({ row: 0, column: index }, event.key, 1, count)
    if (!next || next.column === index) return
    event.preventDefault()
    choose(next.column, true)
  }
  const gridColumns = `repeat(${count}, minmax(0, 1fr))`

  return (
    <figure className={cn("flex min-w-0 flex-col gap-2", className)} aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`} className="sr-only">
        {title}
      </figcaption>
      {asTable ? (
        <div className="min-w-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Paso</TableHead>
                <TableHead scope="col" className="text-right">
                  Importe
                </TableHead>
                {share ? (
                  <TableHead scope="col" className="text-right">
                    {share.heading}
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {steps.map((step, index) => (
                <TableRow key={step.key}>
                  <TableHead scope="row" className={cn(step.kind !== "less" && "font-bold")}>
                    {step.label}
                  </TableHead>
                  <TableCell className="text-right tabular-nums">
                    {lessSign(step)}
                    {format(step.kind === "less" ? Math.abs(step.value) : step.value)}
                  </TableCell>
                  {share ? <TableCell className="text-right tabular-nums">{share.value(index)}</TableCell> : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap items-start gap-4">
          {/* Cada barra necesita su ancho para su importe y su nombre: en una pantalla angosta el gráfico se desplaza solo. */}
          <div className="flex min-w-0 flex-[1_1_480px] gap-2 overflow-x-auto pt-2 pb-1">
            <div aria-hidden className="relative w-12 shrink-0 text-right text-xs text-muted-foreground" style={{ height }}>
              {axisTicks.map((tick) => (
                <span key={tick} className="absolute right-0 translate-y-1/2 tabular-nums" style={{ bottom: `${percent(tick)}%` }}>
                  {short(tick)}
                </span>
              ))}
            </div>
            <div className="flex flex-1 flex-col gap-1.5" style={{ minWidth: `${count * 4.75}rem` }}>
              <div className="relative" style={{ height }}>
                {axisTicks.map((tick) => (
                  <div
                    key={tick}
                    aria-hidden
                    className={cn("absolute inset-x-0 border-t", tick === 0 ? "border-input" : "border-border")}
                    style={{ bottom: `${percent(tick)}%` }}
                  />
                ))}
                <div className="absolute inset-0 grid" style={{ gridTemplateColumns: gridColumns }}>
                  {steps.map((step, index) => {
                    const bar = bars[index] as { from: number; to: number }
                    const lower = Math.min(bar.from, bar.to)
                    const upper = Math.max(bar.from, bar.to)
                    const chosen = index === at
                    const tone = stepTone(step)
                    return (
                      <button
                        key={step.key}
                        ref={(element) => {
                          marks.current[index] = element
                        }}
                        type="button"
                        tabIndex={chosen ? 0 : -1}
                        aria-label={describe(index)}
                        aria-pressed={chosen}
                        onMouseEnter={() => choose(index)}
                        onFocus={() => choose(index)}
                        onClick={() => choose(index)}
                        onKeyDown={(event) => onKeyDown(event, index)}
                        className={cn("relative h-full min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring", chosen && "bg-primary/5")}
                      >
                        <span
                          aria-hidden
                          className={cn("absolute inset-x-[16%] rounded-[4px]", chosen && "ring-2 ring-foreground ring-offset-2 ring-offset-card")}
                          style={{
                            bottom: `${percent(lower)}%`,
                            height: `max(3px, ${percent(upper) - percent(lower)}%)`,
                            background: chosen ? TONE_VAR[tone] : faded(tone),
                          }}
                        />
                        <span
                          aria-hidden
                          className="absolute inset-x-0 text-center text-[11px] font-extrabold whitespace-nowrap tabular-nums text-foreground sm:text-xs"
                          style={{ bottom: `calc(${percent(upper)}% + 4px)` }}
                        >
                          {signed(step)}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
              <div aria-hidden className="grid text-center text-[11px] leading-tight text-muted-foreground sm:text-xs" style={{ gridTemplateColumns: gridColumns }}>
                {steps.map((step, index) => (
                  <span key={step.key} className={cn("px-0.5 break-words hyphens-auto", index === at && "font-bold text-foreground")}>
                    {step.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
          {detail ? (
            <div aria-live="polite" className="flex min-w-60 flex-[0_1_300px] flex-col gap-1.5 rounded-xl border bg-muted/50 p-4">
              {detail(at)}
            </div>
          ) : null}
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="text-[13px] text-muted-foreground">{asTable ? "" : "Pasa el mouse o toca cada barra; con el teclado, las flechas se mueven entre barras."}</span>
        <TableToggle asTable={asTable} onToggle={() => setAsTable((value) => !value)} />
      </div>
    </figure>
  )
}

// --- Mapa de calor -------------------------------------------------------------------------

export interface HeatmapAxis {
  key: string
  /** Rótulo visible; vacío para no rotular esa fila o columna. */
  label: string
  /** Nombre completo para la tabla, cuando el rótulo es corto o está vacío. */
  name?: string
}

export interface HeatmapGridProps {
  title: string
  rows: HeatmapAxis[]
  columns: HeatmapAxis[]
  /** `values[fila][columna]`; `null` es «sin dato» (cerrado, sin horario), distinto del cero. */
  values: Array<Array<number | null>>
  /** Tope de la escala; por defecto, el mayor valor. */
  max?: number
  /** Nombre de cada casilla, con su valor en palabras: «Martes 15 de septiembre: 62 % ocupada». */
  describe: (row: number, column: number, value: number | null) => string
  /** El valor escrito, para la tabla. */
  format: (value: number) => string
  /** Lo que dice el panel de la casilla elegida. */
  detail?: (row: number, column: number, value: number | null) => ReactNode
  /** Los extremos de la leyenda y el nombre del «sin dato». */
  legend: { low: string; high: string; noData?: string }
  /** Casilla elegida al abrir. */
  initial?: { row: number; column: number }
  /** Alto de cada casilla en píxeles; el ancho reparte la fila. */
  cellHeight?: number
  /** Ancho mínimo de la columna de rótulos. */
  labelWidth?: number
  className?: string
}

/**
 * Una cuadrícula de casillas con cuatro pasos de color: días por semana, horas
 * por mes, una semana tipo. Pasar el mouse, tocar o enfocar una casilla la
 * elige y su detalle se lee al lado (región viva). Tab entra al mapa y las
 * flechas se mueven entre casillas; «Ver como tabla» da los valores.
 */
export function HeatmapGrid({
  title,
  rows,
  columns,
  values,
  max,
  describe,
  format,
  detail,
  legend,
  initial,
  cellHeight = 18,
  labelWidth = 44,
  className,
}: HeatmapGridProps) {
  const id = useId()
  const [active, setActive] = useState(() => initial ?? { row: 0, column: Math.max(0, columns.length - 1) })
  const [asTable, setAsTable] = useState(false)
  const cells = useRef(new Map<string, HTMLButtonElement | null>())
  const scroller = useRef<HTMLDivElement | null>(null)
  const top = max ?? Math.max(0, ...values.flat().map((value) => value ?? 0))
  const at = { row: Math.min(active.row, rows.length - 1), column: Math.min(active.column, columns.length - 1) }
  const activeValue = values[at.row]?.[at.column] ?? null

  const choose = (row: number, column: number, focus = false): void => {
    setActive({ row, column })
    if (focus) cells.current.get(`${row}:${column}`)?.focus()
  }
  // En una pantalla angosta el mapa se desplaza: al abrir, deja a la vista la casilla elegida (suele ser lo último).
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    const box = scroller.current
    const cell = cells.current.get(`${at.row}:${at.column}`)
    if (!box || !cell || box.scrollWidth <= box.clientWidth) return
    box.scrollLeft = Math.max(0, cell.offsetLeft - box.clientWidth + cell.offsetWidth * 4)
  })
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const next = moveInGrid(at, event.key, rows.length, columns.length)
    if (!next || (next.row === at.row && next.column === at.column)) return
    event.preventDefault()
    choose(next.row, next.column, true)
  }

  return (
    <figure className={cn("flex min-w-0 flex-col gap-3", className)} aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`} className="sr-only">
        {title}
      </figcaption>
      <div aria-hidden={asTable} className={cn("flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground", asTable && "hidden")}>
        <span>{legend.low}</span>
        {SCALE_VAR.map((color) => (
          <span key={color} className="h-3 w-5 rounded-[3px]" style={{ background: color }} />
        ))}
        <span>{legend.high}</span>
        {legend.noData ? (
          <>
            <span className="ml-2.5 h-3 w-5 rounded-[3px]" style={{ background: NO_DATA_FILL }} />
            <span>{legend.noData}</span>
          </>
        ) : null}
      </div>
      {asTable ? (
        <div className="min-w-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">
                  <span className="sr-only">Fila</span>
                </TableHead>
                {columns.map((column) => (
                  <TableHead key={column.key} scope="col" className="text-right">
                    {column.name ?? column.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, rowIndex) => (
                <TableRow key={row.key}>
                  <TableHead scope="row">{row.name ?? row.label}</TableHead>
                  {columns.map((column, columnIndex) => {
                    const value = values[rowIndex]?.[columnIndex] ?? null
                    return (
                      <TableCell key={column.key} className="text-right tabular-nums">
                        {value === null ? (legend.noData ?? "—") : format(value)}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap items-start gap-4">
          <div ref={scroller} className="relative min-w-0 flex-[1_1_480px] overflow-x-auto">
            <div className="grid min-w-fit gap-[3px]" style={{ gridTemplateColumns: `${labelWidth}px repeat(${columns.length}, minmax(10px, 1fr))` }}>
              <span aria-hidden />
              {columns.map((column, columnIndex) => (
                <span key={column.key} aria-hidden className={cn("whitespace-nowrap text-[11px] leading-4 text-muted-foreground", columnIndex === at.column && "font-bold text-foreground")}>
                  {column.label}
                </span>
              ))}
              {rows.map((row, rowIndex) => (
                <div key={row.key} className="contents">
                  <span aria-hidden className={cn("self-center whitespace-nowrap pr-1 text-[11px] text-muted-foreground", rowIndex === at.row && "font-bold text-foreground")}>
                    {row.label}
                  </span>
                  {columns.map((column, columnIndex) => {
                    const value = values[rowIndex]?.[columnIndex] ?? null
                    const chosen = rowIndex === at.row && columnIndex === at.column
                    return (
                      <button
                        key={column.key}
                        ref={(element) => {
                          cells.current.set(`${rowIndex}:${columnIndex}`, element)
                        }}
                        type="button"
                        tabIndex={chosen ? 0 : -1}
                        aria-label={describe(rowIndex, columnIndex, value)}
                        aria-pressed={chosen}
                        onMouseEnter={() => choose(rowIndex, columnIndex)}
                        onFocus={() => choose(rowIndex, columnIndex)}
                        onClick={() => choose(rowIndex, columnIndex)}
                        onKeyDown={onKeyDown}
                        className={cn(
                          "rounded-[3px] focus-visible:ring-2 focus-visible:ring-ring",
                          chosen ? "outline-2 -outline-offset-1 outline-solid outline-foreground" : "outline-none",
                        )}
                        style={{ height: cellHeight, background: value === null ? NO_DATA_FILL : SCALE_VAR[scaleLevel(value, top)] }}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
          {detail ? (
            <div aria-live="polite" className="flex min-w-60 flex-[0_1_300px] flex-col gap-1.5 rounded-xl border bg-muted/50 p-4">
              {detail(at.row, at.column, activeValue)}
            </div>
          ) : null}
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="text-[13px] text-muted-foreground">{asTable ? "" : "Pasa el mouse o toca una casilla; con el teclado, las flechas se mueven entre casillas."}</span>
        <TableToggle asTable={asTable} onToggle={() => setAsTable((value) => !value)} />
      </div>
    </figure>
  )
}

// --- Barra repartida -----------------------------------------------------------------------

export interface SharePart {
  key: string
  label: string
  value: number
  tone: SeriesTone
}

/**
 * Un total repartido en partes (hasta tres con color y el resto en gris): la
 * barra y, debajo, cada parte con su punto, su valor y su porcentaje escritos.
 */
export function ShareBar({ title, parts, format, className }: { title: string; parts: SharePart[]; format: (value: number) => string; className?: string }) {
  const total = sumOf(parts.map((part) => part.value))
  const share = (value: number): number => (total > 0 ? Math.round((Math.max(0, value) * 100) / total) : 0)
  return (
    <figure className={cn("flex min-w-0 flex-col gap-2.5", className)}>
      <figcaption className="sr-only">{title}</figcaption>
      <div aria-hidden className="flex h-3.5 gap-0.5 overflow-hidden rounded-full bg-secondary">
        {parts
          .filter((part) => part.value > 0)
          .map((part) => (
            <span key={part.key} className="h-full min-w-1" style={{ flex: `${part.value} 1 0`, background: TONE_VAR[part.tone] }} />
          ))}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
        {parts.map((part) => (
          <li key={part.key} className="flex items-baseline gap-1.5">
            <span aria-hidden className="size-2.5 shrink-0 translate-y-[-1px] self-center rounded-full" style={{ background: TONE_VAR[part.tone] }} />
            <span>{part.label}</span>
            <span className="font-semibold tabular-nums">{format(part.value)}</span>
            {total > 0 ? <span className="text-muted-foreground tabular-nums">· {share(part.value)} %</span> : null}
          </li>
        ))}
      </ul>
    </figure>
  )
}
