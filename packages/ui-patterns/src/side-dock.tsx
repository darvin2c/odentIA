import { cn, useSidebarOptional } from "@odentia/ui"
import * as React from "react"
import { createPortal } from "react-dom"

/**
 * Columna lateral del layout: el único lugar a la derecha de la página donde
 * vive lo que se abre «al lado» sin taparla (el formulario o detalle de una
 * lista, el panel del agente). Ocupa todo el alto de la ventana, se
 * redimensiona desde su borde y solo hay una a la vez; cuando no cabe, cada
 * superficie se abre como `Drawer`.
 *
 * - `SideDockProvider` + `SideDockSlot` los pone el layout de la app.
 * - `SideDockPortal` lleva contenido de una página a la columna sin sacarlo de
 *   su árbol de React (estado y contexto siguen siendo los de la página).
 * - `SideColumn` es la columna en sí, con su tirador.
 *
 * Reglas, que este módulo hace cumplir (no dependen de que cada pantalla las
 * recuerde):
 *
 * 1. Una sola columna. La ocupa quien la pide primero y la conserva hasta que
 *    se cierra; nadie se la quita.
 * 2. Lo que se abre DESDE la columna o desde un cajón es siempre un cajón:
 *    dentro de ellos `useDetailMode()` responde `drawer`, así que un
 *    formulario que abre otro formulario lo apila encima sin tocar el primero.
 * 3. Quien pide la columna estando ocupada no se queda sin mostrar: su
 *    contenido sale en el `fallback` (un cajón). Es una red de seguridad, no
 *    un recorrido previsto, y en desarrollo se avisa por consola.
 * 4. El panel del agente no es un formulario: cede la columna si alguien la
 *    pide y se abre como cajón si ya está ocupada (lo decide la app).
 */

interface SideDockState {
  slot: HTMLElement | null
  setSlot: (element: HTMLElement | null) => void
  /** Quienes pidieron la columna, por orden de llegada; el primero la tiene. */
  owners: readonly string[]
  claim: (id: string) => () => void
}

/** Dónde se está renderizando: la página, la columna lateral o un cajón. */
export type SideDockScope = "page" | "column" | "overlay"

const SideDockScopeContext = React.createContext<SideDockScope>("page")

/** Marca lo que hay dentro de la columna o de un cajón (regla 2). */
export function SideDockScopeProvider({
  value,
  children,
}: {
  value: SideDockScope
  children: React.ReactNode
}) {
  return <SideDockScopeContext.Provider value={value}>{children}</SideDockScopeContext.Provider>
}

export function useSideDockScope(): SideDockScope {
  return React.useContext(SideDockScopeContext)
}

const SideDockContext = React.createContext<SideDockState | null>(null)

export function SideDockProvider({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = React.useState<HTMLElement | null>(null)
  const [owners, setOwners] = React.useState<readonly string[]>([])
  const claim = React.useCallback((id: string) => {
    setOwners((current) => (current.includes(id) ? current : [...current, id]))
    return () => setOwners((current) => current.filter((owner) => owner !== id))
  }, [])
  const value = React.useMemo(() => ({ slot, setSlot, owners, claim }), [slot, owners, claim])
  return <SideDockContext.Provider value={value}>{children}</SideDockContext.Provider>
}

/**
 * `available`: el layout ofrece columna lateral. `occupied`: una página ya
 * tiene algo en ella, así que quien llegue después se abre como cajón.
 */
export function useSideDock(): { available: boolean; occupied: boolean } {
  const dock = React.useContext(SideDockContext)
  return { available: dock !== null, occupied: (dock?.owners.length ?? 0) > 0 }
}

/** Lugar de la columna dentro de la fila del layout, a la derecha de la página. */
export function SideDockSlot() {
  const dock = React.useContext(SideDockContext)
  return <div ref={dock?.setSlot} className="contents" />
}

/**
 * Pide la columna del layout mientras viva y monta ahí `children`. Si otro la
 * tiene, monta `fallback` en su lugar (regla 3): quien llega segundo nunca
 * desplaza al primero ni se queda sin mostrarse.
 */
export function SideDockPortal({
  children,
  fallback = null,
}: {
  children: React.ReactNode
  fallback?: React.ReactNode
}) {
  const dock = React.useContext(SideDockContext)
  const id = React.useId()
  const claim = dock?.claim
  React.useEffect(() => claim?.(id), [claim, id])
  const owner = dock?.owners[0]
  const denied = owner !== undefined && owner !== id
  React.useEffect(() => {
    if (denied && process.env.NODE_ENV !== "production") {
      console.error(
        "SideDock: la columna lateral ya está ocupada; este contenido se muestra como cajón. " +
          "Un formulario que se abre con otro ya abierto debe montarse como FormDrawer.",
      )
    }
  }, [denied])
  if (!dock?.slot || owner === undefined) return null
  return denied ? fallback : createPortal(children, dock.slot)
}

export interface SideColumnWidth {
  /** Ancho con el que se abre la primera vez, en px. */
  initial: number
  min: number
  max: number
}

const STEP = 16

const clamp = (value: number, bounds: SideColumnWidth) =>
  Math.min(bounds.max, Math.max(bounds.min, Math.round(value)))

/** Ancho de una columna lateral, recordado en este navegador bajo `storageKey`. */
export function useSideColumnWidth(
  storageKey: string,
  bounds: SideColumnWidth,
): [number, (next: number) => void] {
  const { initial, min, max } = bounds
  const [width, setWidth] = React.useState(initial)
  React.useEffect(() => {
    try {
      const stored = Number(window.localStorage.getItem(storageKey))
      setWidth(
        Number.isFinite(stored) && stored > 0 ? clamp(stored, { initial, min, max }) : initial,
      )
    } catch {
      // Sin almacenamiento (modo privado): queda el ancho por defecto.
    }
  }, [storageKey, initial, min, max])
  const resize = React.useCallback(
    (next: number) => {
      const clamped = clamp(next, { initial, min, max })
      setWidth(clamped)
      try {
        window.localStorage.setItem(storageKey, String(clamped))
      } catch {
        // El ancho vale para esta sesión aunque no se pueda recordar.
      }
    },
    [storageKey, initial, min, max],
  )
  return [width, resize]
}

/** Ancho real del sidebar de la app: abierto, reducido a iconos o ausente. */
export function useSidebarWidth(): number {
  const sidebar = useSidebarOptional()
  if (!sidebar) return 0
  return sidebar.state === "expanded" ? 256 : 48
}

export interface SideColumnProps extends Omit<React.ComponentProps<"aside">, "children"> {
  children: React.ReactNode
  width: number
  onResize: (next: number) => void
  bounds: SideColumnWidth
  /** Ancho que la columna deja siempre a la página, en px. */
  pageMinWidth: number
  /** Nombre accesible del tirador. */
  resizeLabel: string
}

/**
 * Columna a todo el alto, pegada al borde derecho de la ventana. No es modal:
 * la página sigue usable al lado. El tirador se arrastra, se mueve con flechas
 * (Inicio/Fin a los extremos) y vuelve al ancho inicial con doble clic. El
 * tope depende del espacio real (ventana menos sidebar), así que reducir el
 * sidebar deja más ancho a la columna.
 */
export function SideColumn({
  children,
  width,
  onResize,
  bounds,
  pageMinWidth,
  resizeLabel,
  className,
  style,
  ...props
}: SideColumnProps) {
  const sidebar = useSidebarWidth()
  const floor = Math.min(bounds.min, 320)
  // Lo que se guarda nunca supera lo que cabe ahora: si no, el tirador tendría
  // un tramo muerto hasta volver por debajo del tope.
  const apply = (next: number) =>
    onResize(
      Math.min(
        next,
        Math.max(floor, document.documentElement.clientWidth - sidebar - pageMinWidth),
      ),
    )
  return (
    <aside
      {...props}
      className={cn(
        "sticky top-0 flex h-svh shrink-0 flex-col border-l bg-background outline-none",
        className,
      )}
      // Un solo `width`: con `min-width` aparte, el mínimo ganaría al tope y la
      // columna desbordaría en ventanas justas.
      style={{
        ...style,
        width: `min(${width}px, max(${floor}px, calc(100vw - ${sidebar + pageMinWidth}px)))`,
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: separador interactivo (patrón «window splitter» de ARIA); <hr> no admite foco ni valor. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={resizeLabel}
        aria-valuenow={width}
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        tabIndex={0}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:bg-transparent hover:after:bg-border focus-visible:after:bg-ring active:after:bg-ring"
        onPointerDown={(event) => {
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
          // La columna termina en el borde derecho de la ventana.
          apply(document.documentElement.clientWidth - event.clientX)
        }}
        onDoubleClick={() => apply(bounds.initial)}
        onKeyDown={(event) => {
          // Desde el ancho que se ve, que puede ser menor que el guardado.
          const shown = event.currentTarget.parentElement?.getBoundingClientRect().width ?? width
          const next =
            event.key === "ArrowLeft"
              ? shown + STEP
              : event.key === "ArrowRight"
                ? shown - STEP
                : event.key === "Home"
                  ? bounds.min
                  : event.key === "End"
                    ? bounds.max
                    : null
          if (next === null) return
          event.preventDefault()
          apply(next)
        }}
      />
      <SideDockScopeProvider value="column">{children}</SideDockScopeProvider>
    </aside>
  )
}
