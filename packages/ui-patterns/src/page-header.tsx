import { cn, SidebarTrigger, useSidebarOptional } from "@odentia/ui"
import type * as React from "react"
import { useHeaderUtilities } from "./header-utilities.js"

/**
 * Header por página: el primer bloque de contenido de cada pantalla.
 *
 * Sin banda propia: el título va directo sobre el lienzo de la página, con su
 * subtítulo a la izquierda y, a la derecha, las utilidades globales que
 * inyecta el layout (`HeaderUtilitiesProvider`: avisos, selector de
 * organización) separadas por un divisor de las acciones propias de la página.
 *
 * El disparador del sidebar vive aquí solo en móvil (`md:hidden`): en
 * escritorio el colapso está dentro del propio sidebar (`AppShell`), al estilo
 * ChatGPT. Sin `SidebarProvider` (auth, onboarding, páginas públicas) no hay
 * contexto y el control no se renderiza.
 *
 * En anchos cortos la banda envuelve: el título conserva una base mínima
 * (`basis-48`) y, si no cabe todo, las utilidades y acciones bajan completas a
 * una segunda fila antes de recortar el título hasta hacerlo desaparecer.
 */

export interface PageHeaderProps {
  /** Título de la página. Es el `h1` del bloque, no un rótulo de sección. */
  title: string
  /**
   * Línea de contexto bajo el título (recuento, procedencia, antigüedad). Admite
   * un control cuando el contexto se elige ahí mismo, como la sede de la pantalla.
   */
  subtitle?: React.ReactNode
  /** Acciones de la página, alineadas a la derecha y sin partirse de línea. */
  actions?: React.ReactNode
  className?: string
}

function HeaderDivider() {
  // En el teléfono las acciones pueden bajar de fila: ahí la raya quedaría colgando al final.
  return <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-border max-sm:hidden" />
}

export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: PageHeaderProps): React.JSX.Element {
  const sidebar = useSidebarOptional()
  const utilities = useHeaderUtilities()
  const navTrigger = sidebar ? <SidebarTrigger className="-ml-2 shrink-0 md:hidden" /> : null

  return (
    <header
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-3 max-sm:gap-2",
        className,
      )}
    >
      {navTrigger}
      <div className="min-w-0 flex-1 basis-48 max-sm:basis-0">
        <h1 className="truncate text-2xl font-bold tracking-tight text-foreground max-sm:text-xl">{title}</h1>
        {typeof subtitle === "string" ? (
          // En el teléfono el texto de contexto se oculta; los controles (sede, etc.) siguen.
          <p className="truncate text-sm text-muted-foreground max-sm:hidden">{subtitle}</p>
        ) : subtitle ? (
          <div className="flex min-w-0 items-center text-sm text-muted-foreground">{subtitle}</div>
        ) : null}
      </div>
      {utilities || actions ? (
        // En el teléfono, si utilidades y acciones no caben en una fila, las acciones bajan: nunca se salen de la pantalla.
        <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1 max-sm:flex-nowrap max-sm:gap-0.5">
          {utilities}
          {utilities && actions ? <HeaderDivider /> : null}
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
    </header>
  )
}
