import { Badge, cn } from "@odentia/ui"
import type { ReactNode } from "react"

export interface KpiCardProps {
  title: string
  value: string | number
  delta?: { value: string | number; isPositive: boolean }
  /** Icono decorativo del indicador, alineado con el título. */
  icon?: ReactNode
  /**
   * Parte del total que el indicador quiere destacar (confirmadas de las citas,
   * vencidas de las tareas). Es un apoyo visual: la descripción ya dice el dato.
   */
  meter?: { value: number; total: number; tone?: "primary" | "danger" }
  description?: string
  className?: string
}

export function KpiCard({
  title,
  value,
  delta,
  icon,
  meter,
  description,
  className,
}: KpiCardProps) {
  const ratio = meter && meter.total > 0 ? Math.min(1, Math.max(0, meter.value / meter.total)) : 0
  return (
    <div className={cn("elevated h-full rounded-xl border bg-card p-5", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-muted-foreground">
          {icon ? (
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary [&>svg]:size-[15px]"
            >
              {icon}
            </span>
          ) : null}
          <span className="truncate">{title}</span>
        </span>
        {delta ? (
          <Badge variant={delta.isPositive ? "success" : "destructive"}>
            {delta.isPositive ? `+${delta.value}` : delta.value}
          </Badge>
        ) : null}
      </div>
      <div className="mt-3 text-3xl leading-none font-bold tracking-tight text-foreground tabular-nums">
        {value}
      </div>
      {meter ? (
        <div aria-hidden="true" className="mt-3 h-1 overflow-hidden rounded-full bg-secondary">
          <div
            className={cn(
              "h-full rounded-full",
              meter.tone === "danger" ? "bg-destructive" : "bg-primary",
            )}
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
      ) : null}
      {description ? <p className="mt-2 text-xs text-muted-foreground">{description}</p> : null}
    </div>
  )
}
