import { cn } from "@odentia/ui"
import * as React from "react"
import type { ShellLinkComponent } from "../app-shell.js"
import {
  BADGE_CLASSES,
  ITEM_ACTIVE_CLASSES,
  ITEM_CLASSES,
  resolveActiveTo,
  type SectionNavItem,
  type SectionNavMobilePosition,
  type SectionNavSide,
} from "./types.js"

export type {
  SectionNavItem,
  SectionNavMobilePosition,
  SectionNavSide,
} from "./types.js"

export interface SectionNavProps {
  items: SectionNavItem[]
  LinkComponent: ShellLinkComponent
  pathname: string
  /** Nombre accesible del landmark (`aria-label` del `<nav>`). */
  label: string
  /** Contenido de la sección. */
  children: React.ReactNode
  /** Riel a la izquierda (por defecto) o a la derecha del contenido. **Sólo web**
   * (≥1024px): en tablet y móvil la superficie es la barra y esta opción no
   * aplica. */
  side?: SectionNavSide
  /** Borde al que se pega la barra: abajo (por defecto) o arriba. **Sólo tablet
   * y móvil** (<1024px): en web la superficie es el riel y esta opción no
   * aplica. */
  mobilePosition?: SectionNavMobilePosition
  className?: string
}

/**
 * Navegación de una sección dentro del `main` del `AppShell`.
 *
 * **Un solo árbol y una sola superficie en el DOM, y el corte lo hace el CSS**
 * (`lg`: 1024px con el root por defecto). El HTML que manda el servidor ya es
 * el correcto para el ancho que pide el cliente —riel en web, barra en tablet y
 * móvil— porque no depende de JavaScript: nada de `matchMedia`, nada que
 * corregir al hidratar (sin parpadeo) y nada duplicado (dos árboles, uno por
 * breakpoint, repetirían los links y el landmark para lectores de pantalla).
 *
 * En móvil, hasta cinco destinos forman una barra; una lista larga usa un
 * selector que revela opciones verticales desplazables. El riel de escritorio
 * conserva todas las opciones visibles.
 *
 * Se monta dentro del `PageShell`, que aporta fondo de página y padding: el nav
 * no toca ninguno de los dos. Las dos superficies usan la del sidebar
 * (`bg-sidebar`) y el ítem del sidebar (`SidebarMenuButton`).
 */
export function SectionNav({
  items,
  LinkComponent,
  pathname,
  label,
  children,
  side = "left",
  mobilePosition = "footer",
  className,
}: SectionNavProps): React.JSX.Element {
  const activeTo = resolveActiveTo(items, pathname)
  const isRight = side === "right"
  const isBottom = mobilePosition === "footer"
  const hasManyItems = items.length > 5
  const activeItem = activeTo ? items.find((item) => item.to === activeTo) : undefined
  const ActiveIcon = activeItem?.iconActive ?? activeItem?.icon
  const [expanded, setExpanded] = React.useState(false)
  const listId = React.useId()

  return (
    <div
      className={cn(
        // Barra (tablet y móvil): columna, con la altura del viewport menos el
        // padding con que el `PageShell` empuja la sección; sin esto, en una
        // página corta la barra queda al final del contenido en vez de pegada al
        // borde. `overflow-x-clip` evita que su sangrado genere scroll
        // horizontal si la sección no va dentro de una columna con padding.
        "flex w-full flex-col overflow-x-clip",
        "min-h-[calc(100svh-1rem)] sm:min-h-[calc(100svh-1.5rem)]",
        isBottom ? "flex-col-reverse" : "flex-col",
        // Riel (web ≥1024px): el nav y el contenido en fila, y el alto lo pone el
        // contenido (el riel no se estira a todo el alto: no es un segundo
        // sidebar). El scroll horizontal vuelve a ser del contenido.
        "lg:min-h-0 lg:items-start lg:gap-6 lg:overflow-x-visible",
        isRight ? "lg:flex-row-reverse" : "lg:flex-row",
        className,
      )}
    >
      <nav
        aria-label={label}
        className={cn(
          // Barra: a sangre sobre el padding del `PageShell` (el sangrado es sólo
          // de la superficie, para que las celdas lleguen a los dos bordes) y
          // pegada al borde elegido. El sangrado inferior relaja el tope del
          // `sticky`: sin él, al final del scroll la barra queda 16px por encima
          // del borde.
          "[--radius:var(--radius-xl)] sticky z-20 -mx-4 bg-sidebar pt-2 text-sidebar-foreground sm:-mx-6",
          isBottom
            ? "bottom-0 -mb-4 border-t border-sidebar-border pb-[calc(0.5rem+env(safe-area-inset-bottom))] sm:-mb-6"
            : "top-0 border-b border-sidebar-border pb-2",
          // Riel: panel de su alto, dentro de la rejilla de la página y pegado
          // mientras se scrollea. Deshace el sangrado, el borde pegajoso y la
          // altura de la barra.
          "lg:top-6 lg:mx-0 lg:mb-0 lg:w-56 lg:shrink-0 lg:rounded-md lg:border-0 lg:p-2",
          hasManyItems && "flex flex-col",
          hasManyItems && isBottom && "flex-col-reverse lg:flex-col",
          isBottom && "lg:bottom-auto",
        )}
      >
        {hasManyItems ? (
          <button
            type="button"
            className="mx-2 flex min-h-11 items-center gap-2 rounded-xl bg-sidebar-accent px-3 text-left font-semibold text-sidebar-accent-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring lg:hidden"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((current) => !current)}
          >
            {ActiveIcon ? <ActiveIcon /> : null}
            <span className="min-w-0 flex-1 truncate">{activeItem?.label ?? "Elegir sección"}</span>
            <span className="text-xs font-medium">
              {expanded ? "Ocultar secciones" : "Cambiar sección"}
            </span>
          </button>
        ) : null}
        <ul
          id={listId}
          className={cn(
            "gap-0.5",
            hasManyItems
              ? cn(
                  "max-h-[min(60svh,28rem)] flex-col overflow-y-auto overscroll-y-contain px-2 py-2 [scrollbar-width:thin] lg:flex lg:max-h-none lg:overflow-visible lg:p-0",
                  expanded ? "flex" : "hidden",
                )
              : "grid grid-flow-col auto-cols-fr",
            // Riel: lista vertical.
            "lg:flex lg:flex-col",
          )}
        >
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
                  onClick={() => setExpanded(false)}
                  className={cn(
                    ITEM_CLASSES,
                    // Hasta cinco destinos conservan la barra compacta. Una
                    // lista larga usa un selector que abre opciones legibles.
                    hasManyItems
                      ? "min-h-11 flex-row justify-start gap-2 px-3 py-2 text-left text-sm leading-tight"
                      : "min-h-11 flex-col justify-center gap-1 px-1 py-2 text-center text-xs leading-tight",
                    // Riel: fila del sidebar, con su alto y su padding.
                    "lg:h-9 lg:min-h-0 lg:flex-row lg:justify-normal lg:gap-2 lg:px-3 lg:text-left lg:text-sm",
                    active && ITEM_ACTIVE_CLASSES,
                    badge !== undefined && "pr-8",
                  )}
                >
                  {Icon ? <Icon /> : null}
                  <span
                    className={cn(hasManyItems ? "whitespace-normal" : "truncate", "lg:truncate")}
                  >
                    {item.label}
                  </span>
                </LinkComponent>
                {badge === undefined ? null : (
                  <span
                    className={cn(
                      BADGE_CLASSES,
                      hasManyItems
                        ? "pointer-events-none absolute top-1/2 right-2 -translate-y-1/2"
                        : "pointer-events-none absolute top-1 left-1/2 translate-x-1",
                      // Riel: al final de la fila, con el espacio ya reservado
                      // por el `pr-8` del link.
                      "lg:top-1.5 lg:right-1 lg:left-auto lg:translate-x-0 lg:translate-y-0",
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
