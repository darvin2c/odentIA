import { cn } from "@odentia/ui"
import type * as React from "react"
import type { ShellLinkComponent } from "../app-shell.js"
import {
  BADGE_CLASSES,
  ITEM_ACTIVE_CLASSES,
  ITEM_CLASSES,
  resolveActiveTo,
  type SectionNavItem,
  type SectionNavSide,
} from "./types.js"

export interface SectionNavRailProps {
  items: SectionNavItem[]
  LinkComponent: ShellLinkComponent
  pathname: string
  /** Nombre accesible del landmark (`aria-label` del `<nav>`). */
  label: string
  /** Contenido de la sección. */
  children: React.ReactNode
  /** Riel a la izquierda (por defecto) o a la derecha del contenido. */
  side?: SectionNavSide
  className?: string
}

/**
 * Riel vertical: columna de **todo el alto** (`h-svh`, pegada mientras se
 * scrollea) con la superficie del sidebar (`bg-sidebar`, redondeada, sin borde),
 * a ras del sidebar del shell (`-ml-*`/`-mr-*` sobre el padding del `PageShell`)
 * y los ítems a 8px del borde. Los ítems son los del `SidebarMenuButton` (36px,
 * `rounded-xl`, icono de 16px, pastilla `sidebar-accent` en el activo) y la lista
 * scrollea dentro si no cabe.
 *
 * El contador va al final de la fila reservando su espacio (`pr-8`), como en el
 * sidebar del shell, y queda fuera del nombre accesible del link.
 *
 * Sin media queries de forma: es una sola superficie. Para elegir sola según el
 * ancho, usa `SectionNav`.
 */
export function SectionNavRail({
  items,
  LinkComponent,
  pathname,
  label,
  children,
  side = "left",
  className,
}: SectionNavRailProps): React.JSX.Element {
  const activeTo = resolveActiveTo(items, pathname)
  const isRight = side === "right"

  return (
    <div className={cn("flex w-full items-start gap-6", isRight && "flex-row-reverse", className)}>
      <nav
        aria-label={label}
        className={cn(
          // Superficie del sidebar, como pidió el diseño: panel de su alto, con
          // el contenido, dentro de la rejilla de la página y pegado mientras se
          // scrollea (no se estira a todo el alto: no es un segundo sidebar).
          "sticky top-6 w-56 shrink-0 rounded-md bg-sidebar p-2 text-sidebar-foreground",
        )}
      >
        <ul className="[--radius:var(--radius-xl)] flex flex-col gap-0.5">
          {items.map((item) => {
            const active = item.to === activeTo
            const Icon = active && item.iconActive ? item.iconActive : item.icon
            const { badge } = item
            return (
              <li key={item.to} className="relative">
                <LinkComponent
                  to={item.to}
                  title={item.label}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    ITEM_CLASSES,
                    "h-9 px-3 py-2 text-left text-sm",
                    active && ITEM_ACTIVE_CLASSES,
                    badge !== undefined && "pr-8",
                  )}
                >
                  {Icon ? <Icon /> : null}
                  <span className="truncate">{item.label}</span>
                </LinkComponent>
                {badge === undefined ? null : (
                  <span
                    className={cn(
                      BADGE_CLASSES,
                      "pointer-events-none absolute top-1.5 right-1",
                      active ? "text-sidebar-accent-foreground" : "text-sidebar-foreground",
                    )}
                  >
                    {badge}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </nav>
      {/* Sin padding ni fondo: los aporta el `PageShell` que envuelve la sección. */}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
