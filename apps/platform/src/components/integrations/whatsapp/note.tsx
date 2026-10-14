import { cn } from "@odentia/ui"
import { Check, Clock, TriangleAlert } from "lucide-react"
import type { ReactNode } from "react"

export type NoteTone = "ok" | "waiting" | "danger" | "plain"

const TONE: Record<NoteTone, string> = {
  ok: "bg-primary-soft text-primary-soft-foreground",
  waiting: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-destructive",
  plain: "bg-muted text-foreground",
}

const ICON = { ok: Check, waiting: Clock, danger: TriangleAlert } as const

/**
 * Un aviso dentro de la página o del panel: lo que pasó, lo que se espera o lo
 * que hay que corregir. El tono acompaña a las palabras y al icono; nunca dice
 * algo por sí solo.
 */
export function Note({
  tone,
  title,
  children,
  icon = false,
  live = false,
  className,
}: {
  tone: NoteTone
  title?: string
  children?: ReactNode
  /** Con icono: para lo que se comprueba solo (esperando, hecho). */
  icon?: boolean
  /** Cambia sin que la persona haga nada: se anuncia al lector de pantalla. */
  live?: boolean
  className?: string
}) {
  const Icon = icon && tone !== "plain" ? ICON[tone] : null
  return (
    <div role={live ? "status" : undefined} className={cn("flex gap-2.5 rounded-xl px-3.5 py-3 text-sm", TONE[tone], className)}>
      {Icon ? <Icon aria-hidden className="mt-0.5 size-4 shrink-0" /> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-1 [overflow-wrap:anywhere]">
        {title ? <strong className="font-semibold">{title}</strong> : null}
        {children}
      </div>
    </div>
  )
}
