import { cn, SidebarTrigger, useSidebarOptional } from "@odentia/ui"
import type * as React from "react"

/**
 * Header por página: el primer bloque de contenido de cada pantalla.
 *
 * Una sola fila siempre, también en móvil: el título se recorta antes que
 * empujar las acciones a una segunda línea, que en una pantalla de teléfono
 * cuesta media pantalla de scroll. Las acciones nunca se parten ni se envuelven;
 * lo que no cabe en el ancho disponible se recorta por la izquierda del título.
 *
 * En móvil monta el único disparador del drawer del sidebar —el shell no tiene
 * header propio—, así que solo aparece dentro de `AppShell` y por debajo del
 * corte móvil; en escritorio el menú se colapsa desde su riel.
 */

export interface PageHeaderProps {
  /** Título de la página. Es el `h1` del bloque, no un rótulo de sección. */
  title: string
  /** Línea de contexto bajo el título (recuento, procedencia, antigüedad). */
  subtitle?: string
  /** Acciones de la página, alineadas a la derecha y sin partirse de línea. */
  actions?: React.ReactNode
  className?: string
}

export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: PageHeaderProps): React.JSX.Element {
  // El drawer móvil del sidebar no tiene otro disparador: el shell lo deja
  // aquí, en el primer bloque de cada página. Sin `SidebarProvider` (auth,
  // onboarding) no hay contexto y el control no se renderiza.
  const sidebar = useSidebarOptional()
  const navTrigger = sidebar ? <SidebarTrigger className="-ml-2 shrink-0 md:hidden" /> : null

  return (
    <header className={cn("flex min-w-0 items-center justify-between gap-3", className)}>
      <div className="flex min-w-0 items-center gap-3">
        {navTrigger}
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">{title}</h1>
          {subtitle ? <p className="truncate text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}
