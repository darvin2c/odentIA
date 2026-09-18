import * as React from "react"
import type { ShellLinkComponent } from "../app-shell.js"
import { SectionNavBar } from "./bar.js"
import { SectionNavRail } from "./rail.js"
import type { SectionNavItem, SectionNavMobilePosition, SectionNavSide } from "./types.js"

export { SectionNavBar, type SectionNavBarProps } from "./bar.js"
export { SectionNavRail, type SectionNavRailProps } from "./rail.js"
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

/** Corte del riel: riel para web (≥1024px) y barra para tablet y móvil. */
const BAR_QUERY = "(max-width: 1023px)"

// Corrige el modo antes del primer paint (sin flash riel→barra); en el servidor
// cae a `useEffect` para no emitir el aviso de `useLayoutEffect`. Mismo patrón
// que `useDetailMode` de `MasterDetail` y `useResolvedView` de `DataTableView`.
const useEffectBeforePaint: typeof React.useEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

/** `true` cuando toca barra de celdas. Estado inicial estrecho, como los otros
 * cortes del paquete. */
export function useSectionNavBar(): boolean {
  const [isBar, setIsBar] = React.useState(true)

  useEffectBeforePaint(() => {
    if (typeof window.matchMedia !== "function") return
    const query = window.matchMedia(BAR_QUERY)
    const apply = () => setIsBar(query.matches)
    apply()
    query.addEventListener("change", apply)
    return () => query.removeEventListener("change", apply)
  }, [])

  return isBar
}

/**
 * Navegación de una sección dentro del `main` del `AppShell`: elige la
 * superficie según el ancho y monta **una sola** (`SectionNavRail` desde 1024px,
 * `SectionNavBar` en tablet y móvil). Dos árboles, uno por breakpoint,
 * duplicarían los links y el landmark para lectores de pantalla.
 *
 * Se monta dentro del `PageShell`, que aporta fondo de página y padding: el nav
 * no toca ninguno de los dos. Las dos superficies usan la del sidebar
 * (`bg-sidebar`) y el ítem del sidebar (`SidebarMenuButton`).
 *
 * Si la página quiere una superficie concreta siempre, monta `SectionNavRail` o
 * `SectionNavBar` directamente.
 */
export function SectionNav(props: SectionNavProps): React.JSX.Element {
  const isBar = useSectionNavBar()

  if (isBar) {
    return <SectionNavBar {...props} />
  }
  return <SectionNavRail {...props} />
}
