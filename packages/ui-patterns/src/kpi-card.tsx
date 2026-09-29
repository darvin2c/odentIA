import type { ReactNode } from "react"
import { Badge, cn } from "@odentia/ui"

export interface KpiCardProps {
  title: string
  value: string | number
  delta?: { value: string | number; isPositive: boolean }
  /** Icono decorativo del indicador, alineado con el título. */
  icon?: ReactNode
  description?: string
  className?: string
}

export function KpiCard({ title, value, delta, icon, description, className }: KpiCardProps) {
  return (
    <div className={cn("rounded-md bg-card p-6", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-muted-foreground">{title}</span>
        <span className="flex items-center gap-2">
          {delta ? (
            <Badge variant={delta.isPositive ? "success" : "destructive"}>
              {delta.isPositive ? `+${delta.value}` : delta.value}
            </Badge>
          ) : null}
          {icon}
        </span>
      </div>
      <div className="mt-3 text-[28px] font-semibold tabular-nums leading-tight text-foreground">
        {value}
      </div>
      {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
    </div>
  )
}
