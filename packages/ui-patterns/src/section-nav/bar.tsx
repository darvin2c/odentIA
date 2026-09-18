import { cn } from "@odentia/ui"
import type * as React from "react"
import type { ShellLinkComponent } from "../app-shell.js"
import {
  BADGE_CLASSES,
  ITEM_ACTIVE_CLASSES,
  ITEM_CLASSES,
  resolveActiveTo,
  type SectionNavItem,
  type SectionNavMobilePosition,
} from "./types.js"

export interface SectionNavBarProps {
  items: SectionNavItem[]
  LinkComponent: ShellLinkComponent
  pathname: string
  /** Nombre accesible del landmark (`aria-label` del `<nav>`). */
  label: string
  /** Contenido de la sección. */
  children: React.ReactNode
  /** Barra pegada abajo (por defecto) o arriba. */
  mobilePosition?: SectionNavMobilePosition
  className?: string
}

/**
 * Barra de celdas de ancho igual con la superficie del sidebar: icono sobre
 * rótulo, contador sobre el icono y pastilla `sidebar-accent` en el activo. Se
 * pega al borde pedido, a sangre sobre el padding del `PageShell` (`-mx-*` con
 * el padding de vuelta para que las celdas conserven el ancho de la columna) y
 * lleva el alto del indicador de inicio de iOS abajo.
 *
 * Sin scroll horizontal: nada se recorta a mitad de ítem. Sirve 3 a 5 ítems (a
 * 360px cada celda mide ~72px); con más, los rótulos se truncan.
 *
 * Sin media queries: es una sola superficie. Para elegir sola según el ancho,
 * usa `SectionNav`.
 */
export function SectionNavBar({
  items,
  LinkComponent,
  pathname,
  label,
  children,
  mobilePosition = "footer",
  className,
}: SectionNavBarProps): React.JSX.Element {
  const activeTo = resolveActiveTo(items, pathname)
  const isBottom = mobilePosition === "footer"

  return (
    <div
      className={cn(
        // `overflow-x-clip` evita que el sangrado de la barra genere scroll
        // horizontal si la sección no va dentro de una columna con padding.
        "flex w-full flex-col overflow-x-clip",
        // Alto mínimo del viewport menos el padding con que el `PageShell`
        // empuja la sección: sin esto, en una página corta la barra queda al
        // final del contenido en vez de pegada al borde.
        "min-h-[calc(100svh-1rem)] sm:min-h-[calc(100svh-1.5rem)]",
        isBottom && "flex-col-reverse",
        className,
      )}
    >
      <nav
        aria-label={label}
        className={cn(
          "[--radius:var(--radius-xl)]",
          // A sangre sobre el padding del `PageShell`: el sangrado es sólo de la
          // superficie, para que las celdas lleguen a los dos bordes.
          "sticky z-20 -mx-4 bg-sidebar pt-2 text-sidebar-foreground sm:-mx-6",
          isBottom
            ? // El sangrado inferior relaja el tope del `sticky`: sin él, al
              // final del scroll la barra queda 16px por encima del borde.
              "bottom-0 -mb-4 border-t border-sidebar-border pb-[calc(0.5rem+env(safe-area-inset-bottom))] sm:-mb-6"
            : "top-0 border-b border-sidebar-border pb-2",
        )}
      >
        <ul className="grid grid-flow-col auto-cols-fr gap-0.5">
          {items.map((item) => {
            const active = item.to === activeTo
            const Icon = active && item.iconActive ? item.iconActive : item.icon
            const { badge } = item
            return (
              <li key={item.to} className="relative min-w-0">
                <LinkComponent
                  to={item.to}
                  title={item.label}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    ITEM_CLASSES,
                    "flex-col justify-center gap-1 px-1 py-2 text-center text-xs leading-tight",
                    active && ITEM_ACTIVE_CLASSES,
                  )}
                >
                  {Icon ? <Icon /> : null}
                  <span className="w-full truncate">{item.label}</span>
                </LinkComponent>
                {/* Contador sobre el icono, como en una barra de app. */}
                {badge === undefined ? null : (
                  <span
                    className={cn(
                      BADGE_CLASSES,
                      "pointer-events-none absolute top-1 left-1/2 translate-x-1",
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
