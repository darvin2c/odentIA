import { cn } from "@odentia/ui"
import { Bot } from "lucide-react"
import type * as React from "react"

export interface AgentMarkProps {
  size?: "sm" | "md"
  className?: string
}

/**
 * Marca del agente. Identifica lo que el agente propone, ejecuta o deriva con
 * el mismo icono y acento en cualquier pantalla. Es decorativa: el texto que la
 * acompaña nombra al agente, así que no añade un segundo anuncio al lector.
 */
export function AgentMark({ size = "md", className }: AgentMarkProps): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center bg-primary-soft text-primary-soft-foreground",
        size === "sm" ? "size-6 rounded-md [&>svg]:size-3.5" : "size-9 rounded-xl [&>svg]:size-5",
        className,
      )}
    >
      <Bot />
    </span>
  )
}

export interface AgentSurfaceProps extends React.ComponentProps<"section"> {}

/** Superficie de lo que el agente deja en manos del equipo: tinte y borde propios. */
export function AgentSurface({ className, ...props }: AgentSurfaceProps): React.JSX.Element {
  return (
    <section
      className={cn("rounded-xl border border-agent-border bg-agent-soft p-5", className)}
      {...props}
    />
  )
}
