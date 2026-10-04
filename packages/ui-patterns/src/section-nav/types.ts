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

/** Contador: la pastilla de texto del `SidebarMenuBadge` (`h-5 min-w-5`). */
export const BADGE_CLASSES =
  "flex h-5 min-w-5 shrink-0 select-none items-center justify-center rounded-xl px-1 text-xs font-medium tabular-nums"
