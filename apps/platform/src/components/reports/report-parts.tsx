/**
 * Piezas de Reportes: la cifra con su comparación, la tarjeta, las filas con
 * barra y la barra repartida. Las barras son un apoyo visual: cada dato va
 * también en texto, y mejor o peor se dice con palabras y flecha, no solo con color.
 */
import { cn } from "@odentia/ui"
import { ArrowDown, ArrowUp } from "lucide-react"
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

export function ReportCard({
  title,
  note,
  className,
  children,
}: {
  title: string
  /** Aclaración junto al título, como «De toda la clínica». */
  note?: string
  className?: string
  children: ReactNode
}) {
  const id = useId()
  return (
    <section aria-labelledby={id} className={cn("elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-[18px]", className)}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <h3 id={id} className="font-semibold">
          {title}
        </h3>
        {note ? <span className="text-[13px] text-muted-foreground">{note}</span> : null}
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

/** Sin cifra ahora ni antes no hay nada que comparar: se calla en vez de decir «sin datos». */
export function unlessEmpty(current: number, change: Comparison | null): Comparison | null | undefined {
  return change === null && current === 0 ? undefined : change
}

/** Lo que no pertenece a una sede lo dice, en vez de fingir que se filtró. */
export const WHOLE_CLINIC = "De toda la clínica"
