import { cn, useSidebarOptional } from "@odentia/ui"
import * as React from "react"
import { createPortal } from "react-dom"
import { common } from "./common.js"
import type { KeptInPage } from "./draft-blocker.js"

/**
 * Columna lateral del layout: el único lugar a la derecha de la página donde
 * vive lo que se abre «al lado» sin taparla (el formulario o detalle de una
 * lista, los Avisos). Ocupa todo el alto de la ventana, se
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
 *    contenido sale en el `fallback` (un cajón). La decisión se toma al abrir y
 *    no cambia hasta cerrar: pasar de cajón a columna a mitad de una edición
 *    remontaría el formulario.
 * 4. Los Avisos no son un formulario: ceden la columna si alguien la
 *    pide y se abre como cajón si ya está ocupada (lo decide la app).
 */

interface SideDockState {
  slot: HTMLElement | null
  setSlot: (element: HTMLElement | null) => void
  /** Quienes pidieron la columna, por orden de llegada; el primero la tiene. */
  owners: readonly string[]
  claim: (id: string) => () => void
  draftGuard: DraftGuardComponent | null
}

/**
 * Aviso de «salir sin guardar» de la app (depende de su router): lo monta la
 * superficie de la columna mientras tiene cambios pendientes. Con
 * `keptInPage`, navegar sin cambiar de ruta (otra pestaña, otro filtro) no
 * pregunta: la pantalla sigue montada y lo escrito sigue ahí.
 */
export type DraftGuardComponent = React.ComponentType<{
  dirty: boolean
  keptInPage?: KeptInPage | null
  /** Qué se pierde, cuando el contenido lo dijo (`useDraftSaved`); sin él, el texto común. */
  lost?: string | null
  /** Antes de salir con «Descartar y salir»: lo descartado ya no se guarda al cerrarse. */
  onDiscard?: () => void
}>

const DraftKeptInPageContext = React.createContext<KeptInPage | null>(null)

/**
 * Para una pantalla que mantiene montadas sus superficies mientras no cambie
 * de ruta: sus pestañas y filtros solo cambian la búsqueda de la dirección.
 * Ahí el aviso de «salir sin guardar» de la columna solo pregunta al salir a
 * otra ruta, que es cuando se perdería lo escrito. `unlessChanges`: claves de
 * la búsqueda que cambian lo que se guardaría (la sede) y por eso sí preguntan.
 */
export function DraftKeptInPage({
  unlessChanges,
  children,
}: {
  unlessChanges?: readonly string[]
  children: React.ReactNode
}) {
  const value = React.useMemo(() => ({ unlessChanges }), [unlessChanges])
  return <DraftKeptInPageContext.Provider value={value}>{children}</DraftKeptInPageContext.Provider>
}

export function useDraftKeptInPage(): KeptInPage | null {
  return React.useContext(DraftKeptInPageContext)
}

/**
 * Dónde se está renderizando: la página, la columna lateral, un cajón, o una
 * pantalla `fixed` que no puede ceder ancho (ya reparte la ventana en sus
 * propios paneles, como la Bandeja) y por eso abre todo en cajón.
 */
export type SideDockScope = "page" | "column" | "overlay" | "fixed"

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

export function SideDockProvider({
  children,
  draftGuard = null,
}: {
  children: React.ReactNode
  draftGuard?: DraftGuardComponent | null
}) {
  const [slot, setSlot] = React.useState<HTMLElement | null>(null)
  const [owners, setOwners] = React.useState<readonly string[]>([])
  const claim = React.useCallback((id: string) => {
    setOwners((current) => (current.includes(id) ? current : [...current, id]))
    return () => setOwners((current) => current.filter((owner) => owner !== id))
  }, [])
  const value = React.useMemo(
    () => ({ slot, setSlot, owners, claim, draftGuard }),
    [slot, owners, claim, draftGuard],
  )
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

export function useSideDockDraftGuard(): DraftGuardComponent | null {
  return React.useContext(SideDockContext)?.draftGuard ?? null
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
  const release = React.useRef<(() => void) | null>(null)
  const [decision, setDecision] = React.useState<"column" | "fallback" | null>(null)
  React.useEffect(() => {
    if (!claim) return
    const undo = claim(id)
    release.current = undo
    return undo
  }, [claim, id])
  // Se decide con la lista ya asentada (su propio turno registrado): en el
  // mismo commit puede estar cerrándose quien tenía la columna.
  const registered = dock?.owners.includes(id) ?? false
  const owner = dock?.owners[0]
  React.useEffect(() => {
    if (decision !== null || !registered) return
    if (owner === id) {
      setDecision("column")
      return
    }
    // No le tocó: suelta su turno para no retener la columna desde un cajón.
    setDecision("fallback")
    release.current?.()
  }, [decision, registered, owner, id])
  // Sin columna en el layout (o sin su hueco montado) no hay dónde ir.
  if (!dock?.slot || decision === "fallback") return fallback
  return decision === "column" ? createPortal(children, dock.slot) : null
}

/**
 * Ancho de una columna lateral. No tiene tope propio: crece hasta donde la
 * página conserva su ancho mínimo (`pageMinWidth` de `SideColumn`), así que en
 * una pantalla grande o con el menú en iconos el formulario puede ir más ancho.
 */
export interface SideColumnWidth {
  /** Ancho con el que se abre la primera vez, en px. */
  initial: number
  min: number
}

const STEP = 16

/**
 * Dónde se recuerda el ancho de un formulario o detalle de la columna: por el
 * ancho con que abre. Lo que abre igual (un detalle `lg` de una lista, un
 * formulario de 32rem) recuerda lo mismo; uno compacto no hereda el ancho que
 * se le dio a uno grande.
 */
export const sidePanelWidthKey = (bounds: SideColumnWidth) => `odentia.side-panel.${bounds.initial}`

// En el servidor cae a `useEffect` para no emitir el aviso de `useLayoutEffect`.
const useEffectBeforePaint: typeof React.useEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

/** Ancho de una columna lateral, recordado en este navegador bajo `storageKey`. */
export function useSideColumnWidth(
  storageKey: string,
  bounds: SideColumnWidth,
): [number, (next: number) => void] {
  const { initial, min } = bounds
  const [width, setWidth] = React.useState(initial)
  // Antes de pintar: sin tope, el salto del ancho inicial al guardado podía ser
  // de cientos de píxeles en el primer cuadro.
  useEffectBeforePaint(() => {
    try {
      const stored = Number(window.localStorage.getItem(storageKey))
      setWidth(Number.isFinite(stored) && stored > 0 ? Math.max(min, Math.round(stored)) : initial)
    } catch {
      // Sin almacenamiento (modo privado): queda el ancho por defecto.
    }
  }, [storageKey, initial, min])
  const resize = React.useCallback(
    (next: number) => {
      const clamped = Math.max(min, Math.round(next))
      setWidth(clamped)
      try {
        window.localStorage.setItem(storageKey, String(clamped))
      } catch {
        // El ancho vale para esta sesión aunque no se pueda recordar.
      }
    },
    [storageKey, min],
  )
  return [width, resize]
}

// Mientras hay una columna suscrita, el ancho se lee al cambiar la ventana y no
// en cada render: leerlo mientras se arrastra obligaría al navegador a
// recalcular la página en cada movimiento. Sin nadie suscrito se lee al pedirlo,
// porque la ventana pudo cambiar mientras no había columna.
let viewportWidth = 0
let subscribers = 0
const readViewport = () => {
  viewportWidth = document.documentElement.clientWidth
}

const subscribeToViewport = (onChange: () => void) => {
  const update = () => {
    readViewport()
    onChange()
  }
  subscribers += 1
  // El observador también ve la barra de desplazamiento, que aparece y se va sin `resize`.
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null
  if (observer) observer.observe(document.documentElement)
  else window.addEventListener("resize", update)
  return () => {
    subscribers -= 1
    if (observer) observer.disconnect()
    else window.removeEventListener("resize", update)
  }
}

const viewportSnapshot = () => {
  if (subscribers === 0) readViewport()
  return viewportWidth
}

/**
 * Ancho útil de la ventana (sin la barra de desplazamiento), al día al
 * cambiarla. Es la misma medida para el tope, lo que oye el lector de pantalla,
 * las flechas y el ancho que se pinta: con `100vw` (que incluye la barra) el
 * CSS y el cálculo diferían 15 px y una flecha para ensanchar achicaba la
 * columna. La columna solo se monta en el navegador (portal o al abrirse), así
 * que el valor del servidor no llega a pintarse.
 */
function useViewportWidth(): number {
  return React.useSyncExternalStore(subscribeToViewport, viewportSnapshot, () => 0)
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
 * la página sigue usable al lado. El tirador lleva un asa a la vista (la del
 * `ResizableHandle` de shadcn), se arrastra, se mueve con flechas (Inicio/Fin
 * a los extremos) y vuelve al ancho inicial con doble clic. El único tope es
 * el espacio real (ventana menos sidebar menos `pageMinWidth`), así que una
 * pantalla más grande o el sidebar reducido dejan más ancho a la columna.
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
  const viewport = useViewportWidth()
  // Lo que cabe ahora: el único tope.
  const max = Math.max(Math.min(bounds.min, 320), viewport - sidebar - pageMinWidth)
  // Lo que se ve, se anuncia y de donde parten las flechas: lo guardado puede
  // ser de una ventana más grande.
  const shown = Math.min(width, max)
  // Lo que se guarda nunca supera lo que cabe ahora: si no, el tirador tendría
  // un tramo muerto hasta volver por debajo del tope.
  const apply = (next: number) => onResize(Math.min(next, max))
  const keyTargets: Partial<Record<string, number>> = {
    ArrowLeft: shown + STEP,
    ArrowRight: shown - STEP,
    Home: bounds.min,
    End: max,
  }
  return (
    <aside
      {...props}
      className={cn(
        "sticky top-[var(--notice-strip-h,0px)] flex h-[calc(100svh-var(--notice-strip-h,0px))] shrink-0 flex-col border-l bg-background outline-none",
        className,
      )}
      // Un solo `width`: con `min-width` aparte, el mínimo ganaría al tope y la
      // columna desbordaría en ventanas justas.
      style={{ ...style, width: `${shown}px` }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: separador interactivo (patrón «window splitter» de ARIA); <hr> no admite foco ni valor. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={resizeLabel}
        aria-valuenow={shown}
        aria-valuetext={common.sidePanel.width(shown)}
        aria-valuemin={Math.min(bounds.min, max)}
        aria-valuemax={max}
        tabIndex={0}
        className="group absolute inset-y-0 -left-1.5 z-10 w-3 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:bg-transparent hover:after:bg-border focus-visible:after:bg-ring active:after:bg-ring"
        onPointerDown={(event) => {
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
          // La columna termina en el borde derecho de la ventana.
          apply(viewport - event.clientX)
        }}
        // Guarda el de siempre tal cual: si hoy no cabe, lo recorta lo que se
        // ve, y en una ventana más grande vuelve entero.
        onDoubleClick={() => onResize(bounds.initial)}
        onKeyDown={(event) => {
          // Enter es el doble clic del teclado: el ancho de siempre.
          if (event.key === "Enter") {
            event.preventDefault()
            onResize(bounds.initial)
            return
          }
          // Desde el ancho que se ve, calculado y no medido: dos flechas
          // seguidas no parten ambas del ancho anterior.
          const next = keyTargets[event.key]
          if (next === undefined) return
          event.preventDefault()
          apply(next)
        }}
      >
        {/* El asa: dice a la vista que el borde se arrastra, como el `withHandle`
              de `ResizableHandle` (`packages/ui`), con el borde de los campos para
              el contraste 3:1 de un control (WCAG 1.4.11). */}
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-1/2 h-8 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-input-border transition-colors group-hover:bg-ring group-focus-visible:bg-ring group-active:bg-ring motion-reduce:transition-none"
        />
        {/* La pista, al pasar y al enfocar el borde: un `title` no sale con el
              teclado, y un `Tooltip` se quedaba con el Esc que cierra el panel.
              Se esconde al apretar para arrastrar. */}
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-full mr-2 w-max max-w-64 -translate-y-1/2 rounded-xl bg-foreground px-3 py-1.5 text-xs text-background opacity-0 transition-opacity group-hover:opacity-100 group-hover:delay-500 group-focus-visible:opacity-100 group-active:opacity-0 group-active:delay-0 motion-reduce:transition-none"
        >
          {common.sidePanel.resizeHint}
        </span>
      </div>
      <SideDockScopeProvider value="column">{children}</SideDockScopeProvider>
    </aside>
  )
}
