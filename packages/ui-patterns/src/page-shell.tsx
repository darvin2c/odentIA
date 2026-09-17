import { cn } from "@odentia/ui"
import type * as React from "react"

export interface PageShellProps {
  children: React.ReactNode
  className?: string
  /** Centra y acota la columna de contenido (auth y asistentes paso a paso). */
  maxWidth?: "md" | "lg"
}

/**
 * Shell centrado para auth/launcher; respeta tokens de spacing (p-4/5/6 → page-padding 24px)
 * y background de DESIGN.md. Para layout con sidebar 216px, usar Sidebar oficial shadcn/Base UI
 * en la app; este PageShell es el contenedor mínimo compartido.
 */
export function PageShell({ children, className, maxWidth }: PageShellProps) {
  // El fondo cubre todo el viewport; la columna interior acota y paddingea.
  // Evita la "banda" gris recortada que producía bg-muted + mx-auto en el mismo div.
  return (
    <div className="bg-muted min-h-svh w-full">
      <div
        className={cn(
          "mx-auto w-full min-h-full p-4",
          !maxWidth && "sm:p-6",
          maxWidth === "md" && "max-w-2xl",
          maxWidth === "lg" && "max-w-4xl",
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
}
