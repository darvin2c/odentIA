import type { NavIcon } from "../app-shell.js"
import { isNavItemActive } from "../app-shell.js"

/** Ítem de la navegación de sección. Estructuralmente compatible con
 * `AppShellNavItem` (iconos y badge opcionales), así un mismo array sirve para
 * el shell y para la sección sin adaptadores. */
export type SectionNavItem = {
  label: string
  to: string
  icon?: NavIcon
  /** Variante rellena del mismo icono, dibujada cuando el ítem está activo
   * (`RiHomeFill` frente a `RiHomeLine`), igual que hacen las barras de app.
   * Sin ella el activo se distingue sólo por color y grosor, porque los iconos
   * de lucide son de contorno. */
  iconActive?: NavIcon
  badge?: string | number
}

/** Grupo con título: reúne entradas de una lista larga bajo un nombre de trabajo. */
export type SectionNavGroup = {
  label: string
  items: SectionNavItem[]
}

/** Lado del riel respecto al contenido. */
export type SectionNavSide = "left" | "right"

/** Borde de la pantalla al que se pega la barra. */
export type SectionNavMobilePosition = "header" | "footer"

/**
 * Ítem activo. Con `isNavItemActive` (misma semántica que el shell: exacto para
 * `/`, prefijo para el resto) varios ítems pueden coincidir —`/pacientes` y
 * `/pacientes/nuevo` con pathname `/pacientes/nuevo`—; gana la ruta más
 * específica, es decir la más larga.
 */
export function resolveActiveTo(items: SectionNavItem[], pathname: string): string | undefined {
  return items.reduce<string | undefined>(
    (best, item) =>
      isNavItemActive(pathname, item.to) && (best === undefined || item.to.length > best.length)
        ? item.to
        : best,
    undefined,
  )
}

/**
 * Clases comunes del ítem: el del menú del `AppShell` (`SidebarMenuButton`,
 * tamaño default) con su pastilla de activo. Cada superficie añade su forma.
 *
 * El padding es el mismo para todos los ítems, con contador o sin él: cada
 * superficie tiene **una sola geometría**.
 */
export const ITEM_CLASSES =
  "relative flex w-full items-center gap-2 overflow-hidden rounded-xl ring-sidebar-ring outline-hidden transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0"

/** `data-active` del shell: acento de sidebar y mayor peso. En reposo el ítem
 * hereda `text-sidebar-foreground` de la superficie, como en el sidebar. */
export const ITEM_ACTIVE_CLASSES = "bg-sidebar-accent font-semibold text-sidebar-accent-foreground"

/** Título de un grupo: rótulo corto en mayúsculas, más pequeño y gris que las
 * entradas y pegado a ellas (poco aire debajo; la separación va arriba, con la
 * línea entre grupos), para que se lea como encabezado y no como otra opción. */
export const GROUP_LABEL_CLASSES =
  "px-1 pb-0.5 text-[0.5625rem] leading-4 font-bold tracking-[0.1em] text-muted-foreground uppercase lg:px-3"

/** Línea entre grupos (y antes de las sueltas): solo en el riel; en el
 * selector cada grupo ya es su propia tarjeta. */
export const GROUP_SEPARATOR_CLASSES = "mx-3 my-3 hidden h-px shrink-0 bg-sidebar-border lg:block"

/**
 * Lista de un grupo. En la barra (tablet y móvil) es una tarjeta con sus filas
 * separadas; en el riel, la misma lista vertical que sin grupos.
 */
export const GROUP_LIST_CLASSES =
  "flex flex-col divide-y divide-sidebar-border overflow-hidden rounded-xl border border-sidebar-border bg-card lg:gap-0.5 lg:divide-y-0 lg:overflow-visible lg:rounded-none lg:border-0 lg:bg-transparent"

/** Contador: la pastilla de texto del `SidebarMenuBadge` (`h-5 min-w-5`). */
export const BADGE_CLASSES =
  "flex h-5 min-w-5 shrink-0 select-none items-center justify-center rounded-xl px-1 text-xs font-medium tabular-nums"
