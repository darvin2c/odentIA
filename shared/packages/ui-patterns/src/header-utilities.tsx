import * as React from "react"

/**
 * Utilidades globales que el layout inyecta en cada `PageHeader` (buscar,
 * ayuda, avisos) y sus opciones del menú ⋯. Viven aquí para que el encabezado
 * compartido no conozca componentes de ninguna app: sin proveedor, el
 * `PageHeader` no monta nada en ese hueco.
 */
export interface HeaderUtilities {
  /** Botones de la fila: con icono y texto desde tableta; solo icono en el teléfono. */
  utilities?: React.ReactNode
  /** Opciones que el menú ⋯ añade a las de la página (p. ej. «Ayuda» bajo web). */
  menuItems?: React.ReactNode
  /** Lo que el menú lateral cuenta: en el teléfono va sobre su icono, porque el menú está plegado. */
  attention?: { count: number; label: string }
}

const HeaderUtilitiesContext = React.createContext<HeaderUtilities | null>(null)

export function HeaderUtilitiesProvider({
  value,
  children,
}: {
  value: HeaderUtilities
  children: React.ReactNode
}) {
  return <HeaderUtilitiesContext.Provider value={value}>{children}</HeaderUtilitiesContext.Provider>
}

export function useHeaderUtilities(): HeaderUtilities | null {
  return React.useContext(HeaderUtilitiesContext)
}

/** Ancho mínimo que el título conserva antes de compactar la fila (unos 12 caracteres). */
const MIN_TITLE_WIDTH = 192

const HeaderCompactContext = React.createContext(false)

/**
 * Fila compacta: las utilidades quedan solo en íconos y «Ayuda» pasa al menú ⋯.
 * Lo es en el teléfono y, en pantallas mayores, cuando la fila no cabe (un
 * panel lateral abierto, zoom al 125 %). Sin proveedor, falso.
 */
export function useHeaderCompact(): boolean {
  return React.useContext(HeaderCompactContext)
}

export function HeaderCompactProvider({ value, children }: { value: boolean; children: React.ReactNode }) {
  return <HeaderCompactContext.Provider value={value}>{children}</HeaderCompactContext.Provider>
}

/**
 * Mide si la fila del encabezado cabe: compacta cuando el título se recorta por
 * debajo de `MIN_TITLE_WIDTH`. Recuerda cuánto pedían las acciones completas,
 * así solo vuelve a expandirse cuando de verdad caben (sin parpadeo).
 * `measureKey` cambia cuando cambian el título o las acciones.
 */
export function useHeaderFit<TTitle extends HTMLElement, TActions extends HTMLElement>(measureKey: string) {
  const titleRef = React.useRef<TTitle>(null)
  const actionsRef = React.useRef<TActions>(null)
  const [compact, setCompact] = React.useState(false)
  const compactRef = React.useRef(false)
  const fullActionsWidth = React.useRef(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `measureKey` cambia con el título o las acciones que se miden.
  React.useLayoutEffect(() => {
    const title = titleRef.current
    const actions = actionsRef.current
    if (!title || !actions || typeof ResizeObserver === "undefined") return
    const update = (next: boolean) => {
      compactRef.current = next
      setCompact(next)
    }
    const check = () => {
      const wanted = Math.min(title.scrollWidth, MIN_TITLE_WIDTH)
      if (!compactRef.current) {
        fullActionsWidth.current = actions.offsetWidth
        if (title.clientWidth < wanted) update(true)
        return
      }
      // Lo que tendría el título si las acciones volvieran a su ancho completo.
      const room = title.clientWidth + actions.offsetWidth - fullActionsWidth.current
      if (room >= wanted) update(false)
    }
    const observer = new ResizeObserver(check)
    observer.observe(title)
    observer.observe(actions)
    check()
    return () => observer.disconnect()
  }, [measureKey])

  return { compact, titleRef, actionsRef }
}
