import { cn } from "@odentia/ui"
import { ChevronRight } from "lucide-react"
import * as React from "react"
import type { ShellLinkComponent } from "../app-shell.js"
import {
  BADGE_CLASSES,
  GROUP_LABEL_CLASSES,
  GROUP_LIST_CLASSES,
  GROUP_SEPARATOR_CLASSES,
  ITEM_ACTIVE_CLASSES,
  ITEM_CLASSES,
  resolveActiveTo,
  type SectionNavGroup,
  type SectionNavItem,
  type SectionNavMobilePosition,
  type SectionNavSide,
} from "./types.js"

export type {
  SectionNavGroup,
  SectionNavItem,
  SectionNavMobilePosition,
  SectionNavSide,
} from "./types.js"

export interface SectionNavProps {
  /** Entradas de la sección. Con `groups` son las sueltas: van al final, tras
   * un separador. */
  items: SectionNavItem[]
  /** Grupos con título, antes de las entradas sueltas. Para listas largas que
   * se leen mejor por tema que de corrido. */
  groups?: SectionNavGroup[]
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

/** Forma de la entrada según la superficie que la contiene. */
type EntryShape = "bar" | "picker" | "group"

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
 * Con `groups`, la lista se lee por temas: cada grupo lleva su título y las
 * entradas sueltas (`items`) quedan al final, tras un separador. En el riel son
 * rótulos sobre la misma lista; en el selector de tablet y móvil, una tarjeta
 * por grupo con una fila por entrada.
 *
 * Se monta dentro del `PageShell`, que aporta fondo de página y padding: el nav
 * no toca ninguno de los dos. Las dos superficies usan la del sidebar
 * (`bg-sidebar`) y el ítem del sidebar (`SidebarMenuButton`).
 */
export function SectionNav({
  items,
  groups = [],
  LinkComponent,
  pathname,
  label,
  children,
  side = "left",
  mobilePosition = "footer",
  className,
}: SectionNavProps): React.JSX.Element {
  const isGrouped = groups.length > 0
  const allItems = isGrouped ? [...groups.flatMap((group) => group.items), ...items] : items
  const activeTo = resolveActiveTo(allItems, pathname)
  const isRight = side === "right"
  const isBottom = mobilePosition === "footer"
  // Una lista agrupada no cabe en una barra de celdas: siempre usa el selector.
  const usesPicker = isGrouped || allItems.length > 5
  const activeItem = activeTo ? allItems.find((item) => item.to === activeTo) : undefined
  const ActiveIcon = activeItem?.iconActive ?? activeItem?.icon
  const [expanded, setExpanded] = React.useState(false)
  const listId = React.useId()

  const renderEntry = (item: SectionNavItem, shape: EntryShape) => {
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
            // Hasta cinco destinos conservan la barra compacta. Una lista larga
            // usa un selector que abre opciones legibles; agrupada, cada opción
            // es una fila de su tarjeta.
            shape === "bar"
              ? "min-h-11 flex-col justify-center gap-1 px-1 py-2 text-center text-xs leading-tight"
              : "min-h-11 flex-row justify-start gap-2 px-3 py-2 text-left text-sm leading-tight",
            shape === "group" && "rounded-none lg:rounded-xl",
            // Riel: fila del sidebar, con su alto y su padding.
            "lg:h-9 lg:min-h-0 lg:flex-row lg:justify-normal lg:gap-2 lg:px-3 lg:text-left lg:text-sm",
            active && ITEM_ACTIVE_CLASSES,
            badge !== undefined && (shape === "group" ? "pr-16 lg:pr-8" : "pr-8"),
          )}
        >
          {Icon ? <Icon /> : null}
          <span
            className={cn(
              shape === "bar" ? "truncate" : "whitespace-normal",
              shape === "group" && "min-w-0 flex-1",
              "lg:truncate",
            )}
          >
            {item.label}
          </span>
          {shape === "group" ? (
            <ChevronRight aria-hidden className="text-muted-foreground lg:hidden" />
          ) : null}
        </LinkComponent>
        {badge === undefined ? null : (
          <span
            className={cn(
              BADGE_CLASSES,
              shape === "bar"
                ? "pointer-events-none absolute top-1 left-1/2 translate-x-1"
                : "pointer-events-none absolute top-1/2 -translate-y-1/2",
              // En la tarjeta del grupo el contador deja sitio a la flecha.
              shape === "picker" && "right-2",
              shape === "group" && "right-9",
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
  }

  // Lista del selector: oculta en la barra hasta abrirlo y siempre visible en
  // el riel. Compartida por la lista larga y por la agrupada, que toma casi
  // toda la pantalla: con sus títulos se lee como una página, entera cuando cabe.
  // El padding lateral deshace el sangrado del nav: la raíz recorta lo que
  // sobresale, así que el contenido se alinea con ella para no quedar cortado.
  // scroll-nativo: la misma lista es menú desplegable en la barra y riel visible
  // en ancho (`lg:overflow-visible`); ScrollArea no se apaga por ancho. Barra fina.
  const pickerListClasses = cn(
    "flex-col overflow-y-auto overscroll-y-contain px-4 py-2 [scrollbar-width:thin] sm:px-6 lg:flex lg:max-h-none lg:overflow-visible lg:p-0",
    // Todo el alto menos el botón del selector y su aire (y el margen seguro
    // del teléfono): si el nav midiera más que la pantalla, al estar pegado
    // abajo sus primeras filas quedarían fuera de alcance.
    isGrouped
      ? "max-h-[calc(100svh-4.5rem-env(safe-area-inset-bottom))]"
      : "max-h-[min(60svh,28rem)]",
    expanded ? "flex" : "hidden",
  )

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
          "lg:top-6 lg:mx-0 lg:mb-0 lg:shrink-0 lg:rounded-md lg:border-0 lg:p-2",
          // Agrupado es más ancho (sus nombres son frases) y, si la ventana es
          // más baja que la lista, se desplaza dentro del riel en vez de
          // quedar cortado mientras está pegado.
          // scroll-nativo: solo en el riel agrupado y solo si la ventana es más baja que la lista; barra fina.
          isGrouped
            ? "lg:max-h-[calc(100svh-3rem)] lg:w-64 lg:overflow-y-auto lg:[scrollbar-width:thin]"
            : "lg:w-56",
          usesPicker && "flex flex-col",
          usesPicker && isBottom && "flex-col-reverse lg:flex-col",
          isBottom && "lg:bottom-auto",
        )}
      >
        {usesPicker ? (
          <button
            type="button"
            className="mx-4 flex min-h-11 items-center gap-2 rounded-xl bg-sidebar-accent px-3 text-left font-semibold text-sidebar-accent-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring sm:mx-6 lg:hidden"
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
        {isGrouped ? (
          <div id={listId} className={cn("gap-3 lg:gap-0", pickerListClasses)}>
            {groups.map((group, index) => {
              const headingId = `${listId}-grupo-${index}`
              return (
                <div
                  key={group.label}
                  role="group"
                  aria-labelledby={headingId}
                  // `shrink-0`: en una pantalla baja la lista se desplaza; un grupo
                  // nunca se encoge recortando sus filas.
                  className={cn("flex shrink-0 flex-col", index === 0 && "lg:pt-1")}
                >
                  {/* En el riel, una línea separa cada grupo del anterior; solo
                      visual, porque el grupo ya se anuncia con su título. En el
                      selector lo separa su tarjeta. */}
                  {index > 0 ? <div aria-hidden className={GROUP_SEPARATOR_CLASSES} /> : null}
                  <p id={headingId} className={GROUP_LABEL_CLASSES}>
                    {group.label}
                  </p>
                  <ul className={GROUP_LIST_CLASSES}>
                    {group.items.map((item) => renderEntry(item, "group"))}
                  </ul>
                </div>
              )
            })}
            {items.length > 0 ? (
              <>
                {/* En el riel, una línea separa lo que no pertenece a un grupo;
                    en el selector ya lo separa su propia tarjeta. */}
                <div role="separator" className={GROUP_SEPARATOR_CLASSES} />
                <ul className={cn(GROUP_LIST_CLASSES, "shrink-0")}>
                  {items.map((item) => renderEntry(item, "group"))}
                </ul>
              </>
            ) : null}
          </div>
        ) : (
          <ul
            id={listId}
            className={cn(
              "gap-0.5",
              usesPicker ? pickerListClasses : "grid grid-flow-col auto-cols-fr",
              // Riel: lista vertical.
              "lg:flex lg:flex-col",
            )}
          >
            {items.map((item) => renderEntry(item, usesPicker ? "picker" : "bar"))}
          </ul>
        )}
      </nav>
      {/* Sin padding ni fondo: los aporta el `PageShell` que envuelve la sección. */}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
