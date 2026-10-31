/**
 * Piezas de Reportes: la cifra con su comparación, la cifra con su línea de
 * 12 meses, la tarjeta, las filas con barra y la barra repartida. Las barras
 * son un apoyo visual: cada dato va también en texto, y mejor o peor se dice
 * con palabras y flecha, no solo con color.
 */
import { Button, cn, toast } from "@odentia/ui"
import { Sparkline, SubmitButton } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, Download } from "lucide-react"
import { mutationErrorMessage } from "../../lib/query-error"
import { type ReactNode, useId } from "react"
import type { Comparison } from "../../lib/reports"

/** Qué sentido es bueno para una cifra: sin él, la comparación no se colorea. */
export type Better = "up" | "down" | "none"

function changeTone(change: Comparison, better: Better): string {
  if (better === "none" || change.direction === "same") return "text-muted-foreground"
  return change.direction === better ? "text-success" : "text-warning"
}

/** «8 % más que en agosto», con su flecha. Sin base con qué comparar, lo dice. */
export function ChangeLine({
  change,
  better = "none",
  className,
}: {
  change: Comparison | null
  better?: Better
  className?: string
}) {
  if (!change) return <span className={cn("text-[13px] text-muted-foreground", className)}>Sin datos del periodo anterior</span>
  const Arrow = change.direction === "up" ? ArrowUp : change.direction === "down" ? ArrowDown : null
  return (
    <span className={cn("inline-flex items-center gap-1 text-[13px] font-semibold", changeTone(change, better), className)}>
      {Arrow ? <Arrow aria-hidden className="size-3 shrink-0" strokeWidth={2.5} /> : null}
      {change.text}
    </span>
  )
}

/** Una cifra destacada: rótulo, valor, comparación y, si hace falta, una nota o un enlace. */
export function Figure({
  title,
  value,
  detail,
  change,
  better,
  note,
  tone = "plain",
  children,
}: {
  title: string
  value: ReactNode
  /** Lo que acompaña al valor en pequeño: «· 18 de 29». */
  detail?: string
  /** `undefined`: la cifra no se compara; `null`: no hay base con qué comparar. */
  change?: Comparison | null
  better?: Better
  note?: string
  tone?: "plain" | "attention"
  children?: ReactNode
}) {
  const attention = tone === "attention"
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-0.5 rounded-xl px-[18px] py-4",
        attention ? "bg-warning-soft" : "elevated border bg-card",
      )}
    >
      <span className={cn("text-[13px] font-semibold", attention ? "text-warning" : "text-muted-foreground")}>{title}</span>
      <span className="text-[26px] leading-8 font-bold tracking-tight tabular-nums">
        {value}
        {detail ? <span className="text-sm font-semibold text-muted-foreground"> {detail}</span> : null}
      </span>
      {change !== undefined ? <ChangeLine change={change} better={better} /> : null}
      {note ? <span className={cn("text-[13px]", attention ? "text-warning" : "text-muted-foreground")}>{note}</span> : null}
      {children}
    </div>
  )
}

/** «en setiembre de 2026» o «del 10 al 25 de setiembre de 2026»: un rango ya trae su preposición. */
export function during(period: string): string {
  return /^(del|el) /.test(period) ? period : `en ${period}`
}

/** «de S/ 38 900 a S/ 48 200»: el recorrido de la línea pequeña dicho con palabras. */
export function travel(values: Array<number | null>, format: (value: number) => string): string {
  const known = values.filter((value): value is number => value !== null)
  if (known.length === 0) return "sin datos"
  if (known.length === 1) return format(known[0] as number)
  return `de ${format(known[0] as number)} a ${format(known[known.length - 1] as number)}`
}

/** Una cifra con su comparación y su línea de 12 meses (Resumen y Agente). */
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
  goal,
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
  /** La meta del mes y su avance, o «Poner meta» (tablero 6). */
  goal?: ReactNode
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
      {goal}
      {footer ? <div className="mt-auto pt-1.5">{footer}</div> : null}
    </section>
  )
}

/**
 * «Descargar» de una lista o una tabla (decisión 11): un CSV con las mismas
 * filas y columnas; el archivo lo arma el servidor.
 */
export function DownloadButton({ onDownload, label = "Descargar" }: { onDownload: () => Promise<void>; label?: string }) {
  const download = useMutation({ retry: false, mutationFn: onDownload, onError: (error) => toast.error(mutationErrorMessage(error)) })
  return (
    <SubmitButton type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" pending={download.isPending} onClick={() => download.mutate()}>
      <Download aria-hidden />
      {label}
    </SubmitButton>
  )
}

/** El pie de una cifra que abre su lista: «Ver quiénes», «Ver cuáles». */
export function FooterButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button type="button" variant="link" className="h-auto min-h-11 p-0 text-[13px] font-bold sm:min-h-8" onClick={onClick}>
      {children}
    </Button>
  )
}

export function ReportCard({
  title,
  note,
  action,
  className,
  stale = false,
  children,
}: {
  title: string
  /** Aclaración junto al título, como «De toda la clínica». */
  note?: string
  /** Lo que se hace con la tarjeta entera, a la derecha del título: «Descargar». */
  action?: ReactNode
  className?: string
  /** Lo que se ve aún es del periodo anterior: el nuevo viene en camino. */
  stale?: boolean
  children: ReactNode
}) {
  const id = useId()
  return (
    <section aria-labelledby={id} aria-busy={stale || undefined} className={cn("elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-[18px] transition-opacity", stale && "opacity-60", className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 id={id} className="font-semibold">
          {title}
        </h3>
        {note ? <span className="text-[13px] text-muted-foreground">{note}</span> : null}
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

export interface BarRow {
  key: string
  label: ReactNode
  /** Lo que se lee a la derecha: un conteo o un importe ya escrito. */
  value: string
  /** Ancho de la barra, 0–100. */
  share: number
  /** Porcentaje escrito junto al valor; sin él no se muestra. */
  percent?: number | null
  tone?: "primary" | "attention" | "muted"
  action?: ReactNode
}

const BAR_TONE = { primary: "bg-primary", attention: "bg-warning", muted: "bg-muted-foreground/50" }

/** Filas con nombre, porcentaje e importe en texto y una barra decorativa debajo. */
export function BarRows({ rows }: { rows: BarRow[] }) {
  return (
    <ul className="flex min-w-0 flex-col gap-2.5">
      {rows.map((row) => (
        <li key={row.key} className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-baseline gap-3 text-sm">
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            {row.percent != null ? <span className="shrink-0 text-muted-foreground tabular-nums">{row.percent} %</span> : null}
            <span className="shrink-0 font-semibold tabular-nums">{row.value}</span>
          </div>
          <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-secondary">
            <div className={cn("h-full rounded-full", BAR_TONE[row.tone ?? "primary"])} style={{ width: `${Math.max(0, Math.min(100, row.share))}%` }} />
          </div>
          {row.action}
        </li>
      ))}
    </ul>
  )
}

export interface StackPart {
  key: string
  label: string
  count: number
  tone: "primary" | "attention" | "muted" | "outline"
}

const STACK_TONE = {
  primary: "bg-primary",
  attention: "bg-warning",
  muted: "bg-muted-foreground/40",
  outline: "border border-muted-foreground/60 bg-card",
}

/** Un total repartido en partes: la barra y, debajo, cada parte con su punto de color. */
export function StackedBar({ parts }: { parts: StackPart[] }) {
  const visible = parts.filter((part) => part.count > 0)
  return (
    <div aria-hidden className="flex h-3.5 gap-0.5 overflow-hidden rounded-full">
      {visible.map((part) => (
        <div key={part.key} className={cn("h-full min-w-1", STACK_TONE[part.tone])} style={{ flex: `${part.count} 1 0` }} />
      ))}
    </div>
  )
}

export function StackDot({ tone }: { tone: StackPart["tone"] }) {
  return <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", STACK_TONE[tone])} />
}

/**
 * Una tarjeta sin datos lo dice en una línea, con su salida si la hay: dentro
 * de una pantalla llena de cifras, un estado vacío grande estorba más que ayuda.
 */
export function EmptyLine({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm text-muted-foreground">
      <span>{children}</span>
      {action}
    </p>
  )
}

/**
 * Al cambiar de periodo o de sede, las cifras anteriores siguen a la vista,
 * atenuadas, hasta que llegan las nuevas: la pantalla no se vacía ni salta.
 */
export function ReportBody({ stale, className, children }: { stale: boolean; className?: string; children: ReactNode }) {
  return (
    <div aria-busy={stale || undefined} className={cn("flex min-w-0 flex-col gap-4 transition-opacity", stale && "opacity-60", className)}>
      {stale ? (
        <span role="status" className="sr-only">
          Actualizando las cifras…
        </span>
      ) : null}
      {children}
    </div>
  )
}

/** Sin cifra ahora ni antes no hay nada que comparar: se calla en vez de decir «sin datos». */
export function unlessEmpty(current: number, change: Comparison | null): Comparison | null | undefined {
  return change === null && current === 0 ? undefined : change
}

/** Lo que no pertenece a una sede lo dice, en vez de fingir que se filtró. */
export const WHOLE_CLINIC = "De toda la clínica"
