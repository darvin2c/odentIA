import { cn } from "@odentia/ui"
import * as React from "react"

const InsidePageShell = React.createContext(false)

/** Si ya hay un `PageShell` arriba: lo que se monta dentro no pone otro. */
export function useInsidePageShell(): boolean {
  return React.useContext(InsidePageShell)
}

export interface PageShellProps {
  children: React.ReactNode
  className?: string
  /** Centra y acota la columna de contenido (auth y asistentes paso a paso). */
  maxWidth?: "md" | "lg"
  /**
   * Ocupa exactamente el viewport y no scrollea la página: el contenido interno
   * administra su propio scroll (bandeja, tableros). Requiere que el hijo use
   * `min-h-0 flex-1` para repartir el alto restante.
   */
  fill?: boolean
}

/**
 * Shell centrado para auth/launcher; respeta tokens de spacing (p-4/5/6 → page-padding 24px)
 * y background de DESIGN.md. Para layout con sidebar 216px, usar Sidebar oficial shadcn/Base UI
 * en la app; este PageShell es el contenedor mínimo compartido.
 */
export function PageShell({ children, className, maxWidth, fill }: PageShellProps) {
  // El fondo cubre todo el viewport; la columna interior acota y paddingea.
  // Evita la "banda" gris recortada que producía bg-muted + mx-auto en el mismo div.
  // `fill` se mide con el alto visible (dvh): en el celular, el teclado no tapa
  // lo que queda pegado abajo (la caja de la Bandeja).
  return (
    <div className={cn("bg-canvas w-full", fill ? "h-[calc(100dvh-var(--notice-strip-h,0px))] overflow-hidden" : "min-h-[calc(100svh-var(--notice-strip-h,0px))]")}>
      <div
        className={cn(
          "mx-auto w-full p-4",
          !fill && "min-h-full",
          fill && "flex h-full min-h-0 flex-col",
          !maxWidth && "sm:p-6",
          maxWidth === "md" && "max-w-2xl",
          maxWidth === "lg" && "max-w-4xl",
          className,
        )}
      >
        <InsidePageShell.Provider value={true}>{children}</InsidePageShell.Provider>
      </div>
    </div>
  )
}
