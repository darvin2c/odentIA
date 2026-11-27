import { Badge, cn } from "@odentia/ui"
import { AgentMark } from "@odentia/ui-patterns"
import {
  CalendarHeart,
  Crown,
  HeartHandshake,
  type LucideIcon,
  PackagePlus,
  RefreshCw,
  ShoppingCart,
  Sunrise,
  Sparkles,
  Tag,
} from "lucide-react"
import type { ReactNode } from "react"
import type { AccionId, Seg } from "./datos"
import { SEG } from "./datos"

export const ICONOS: Record<AccionId, LucideIcon> = {
  cart: ShoppingCart,
  cruzada: PackagePlus,
  recompra: RefreshCw,
  cumple: CalendarHeart,
  vip: Crown,
  recuperar: HeartHandshake,
  despertar: Sunrise,
  nuevo: Sparkles,
  liq: Tag,
}

/** El grupo de la clienta, con su color. */
export function SegBadge({ seg, className }: { seg: Seg; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("border-transparent gap-1.5", SEG[seg].className, className)}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {SEG[seg].label}
    </Badge>
  )
}

/** Una tarjeta de contenido, como las de la ficha del producto. */
export function Tarjeta({
  title,
  subtitle,
  action,
  children,
  className,
  id,
}: {
  title?: string
  subtitle?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <section
      id={id}
      aria-label={title}
      className={cn(
        "elevated flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-5",
        className,
      )}
    >
      {title ? (
        <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="text-base font-semibold">{title}</h2>
            {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  )
}

/** «Lo hizo Argos»: la marca del agente con su nombre. */
export function DeArgos({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}
    >
      <AgentMark size="sm" />
      {children}
    </span>
  )
}

/** Un mensaje de WhatsApp, tal como le llega a la clienta. */
export function Burbuja({
  children,
  plantilla,
  pie,
  botones,
  className,
}: {
  children: ReactNode
  plantilla?: string | null
  pie?: string
  botones?: string[]
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-1.5 rounded-xl bg-surface-muted/70 p-2.5", className)}>
      {plantilla !== undefined ? (
        <span className="px-1 text-[11px] font-semibold text-muted-foreground">
          {plantilla
            ? `Plantilla «${plantilla}» · promoción`
            : "Dentro de las 24 h · sin plantilla"}
        </span>
      ) : null}
      <div className="rounded-2xl rounded-br-md border border-agent-border bg-agent-soft px-3.5 py-2.5 text-sm leading-relaxed">
        {children}
        {botones ? (
          <span className="mt-2 flex gap-1.5">
            {botones.map((b) => (
              <span
                key={b}
                className="flex-1 rounded-lg bg-card px-2 py-1.5 text-center text-[13px] font-medium text-primary shadow-xs"
              >
                {b}
              </span>
            ))}
          </span>
        ) : null}
        {pie ? (
          <span className="mt-1 block text-right text-[11px] text-muted-foreground">{pie}</span>
        ) : null}
      </div>
    </div>
  )
}
