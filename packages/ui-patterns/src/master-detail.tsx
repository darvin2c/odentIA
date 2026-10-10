import {
  cn,
  Drawer,
  DrawerContent,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePanelRef,
} from "@odentia/ui"
import * as React from "react"
import { common } from "./common.js"
import {
  SideColumn,
  type SideColumnWidth,
  SideDockPortal,
  SideDockScopeProvider,
  useSideColumnWidth,
  useSideDock,
  useSideDockScope,
} from "./side-dock.js"

/** Corte del modo panel: el ancho donde tabla y tarjeta caben a la vez. */
const PANEL_QUERY = "(min-width: 1280px)"

/** Igual que el corte del modo: el detalle no anima para quien pidió menos movimiento. */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

/**
 * Duración y curva de la entrada/salida del detalle, copiadas del drawer
 * (`packages/ui/src/components/drawer.tsx`) para que abrir el panel y abrir el
 * drawer se sientan igual: el mismo movimiento en los dos modos.
 */
const SLIDE_MS = 450

// Transición de ancho del panel. Son tres clases y no una porque Tailwind no
// genera una propiedad arbitraria (`[transition:...]`) dentro de una variante
// arbitraria, y van literales porque el escáner lee texto, no interpolaciones.
// El selector entra por el div externo del panel: ahí escribe la librería el
// `flex-grow` que hay que interpolar. `data-animating` la enciende solo durante
// el cambio programático, nunca durante el arrastre.
const ANCHO_ANIMADO =
  "[&[data-animating=true]>[data-slot=resizable-panel]]:transition-[flex-grow] [&[data-animating=true]>[data-slot=resizable-panel]]:duration-[450ms] [&[data-animating=true]>[data-slot=resizable-panel]]:ease-[cubic-bezier(0.22,1,0.36,1)]"

// El formulario entra y sale deslizando desde su borde, con el movimiento del
// popup del drawer. Va dentro de una caja que recorta (`relative
// overflow-hidden`) para que el desplazamiento no agrande el área scrolleable
// del panel. `motion-reduce:transition-none` cubre el deslizamiento; el ancho
// lo cubre el interruptor de `usePrefersReducedMotion`.
const CONTENIDO_ANIMADO =
  "absolute inset-0 transition-[translate] duration-450 ease-[cubic-bezier(0.22,1,0.36,1)] data-open:translate-x-0 data-closed:translate-x-full motion-reduce:transition-none"

export type DetailMode = "panel" | "drawer"

/** Anchos predefinidos de la columna de detalle: de formulario compacto a wizard. */
export type DetailPanelSize = "md" | "lg" | "xl"

const PANEL_SIZES: Record<DetailPanelSize, { default: string; min: string; max: string }> = {
  md: { default: "24rem", min: "20rem", max: "32rem" },
  lg: { default: "32rem", min: "26rem", max: "40rem" },
  xl: { default: "40rem", min: "32rem", max: "52rem" },
}

/** Los mismos anchos, en px, cuando el detalle va en la columna del layout. */
const DOCK_SIZES: Record<DetailPanelSize, SideColumnWidth> = {
  md: { initial: 384, min: 320, max: 512 },
  lg: { initial: 512, min: 416, max: 640 },
  xl: { initial: 640, min: 512, max: 832 },
}
/** Ancho que el detalle deja a la lista: el mínimo de la columna maestra. */
const MASTER_MIN_WIDTH = 512

// Corrige el modo antes del primer paint (sin flash drawer→panel); en el
// servidor cae a `useEffect` para no emitir el aviso de `useLayoutEffect`.
// Mismo patrón que `useResolvedView` de data-table-view.
const useEffectBeforePaint: typeof React.useEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

/**
 * Modo efectivo del detalle: `panel` cuando hay ancho para la tabla y la
 * tarjeta lateral a la vez, `drawer` en el resto. El estado inicial es el
 * estrecho a propósito, igual que `useResolvedView`.
 *
 * Dentro de la columna lateral o de un cajón responde siempre `drawer`: lo que
 * se abre desde ahí se apila encima, nunca compite por la columna (ver las
 * reglas de `side-dock`).
 *
 * No usa `useIsMobile` (corta en 768px): tabla + panel de 24rem necesitan
 * bastante más. Vive aquí y no en `packages/ui` porque el corte debe coincidir
 * con lo que la página renderiza como alternativa (`FormDrawer`).
 */
export function useDetailMode(): DetailMode {
  const scope = useSideDockScope()
  const [isWide, setIsWide] = React.useState(false)

  useEffectBeforePaint(() => {
    if (typeof window.matchMedia !== "function") return
    const query = window.matchMedia(PANEL_QUERY)
    const apply = () => setIsWide(query.matches)
    apply()
    query.addEventListener("change", apply)
    return () => query.removeEventListener("change", apply)
  }, [])

  return isWide && scope === "page" ? "panel" : "drawer"
}

/**
 * Quien pidió menos movimiento no recibe ninguna animación. Se consulta en JS y
 * no solo por CSS porque el interruptor también decide si la transición de
 * ancho se enciende: con `reduce` el detalle aparece y desaparece de una.
 */
function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = React.useState(false)

  useEffectBeforePaint(() => {
    if (typeof window.matchMedia !== "function") return
    const query = window.matchMedia(REDUCED_MOTION_QUERY)
    const apply = () => setReduce(query.matches)
    apply()
    query.addEventListener("change", apply)
    return () => query.removeEventListener("change", apply)
  }, [])

  return reduce
}

export interface MasterDetailProps {
  /** Contenido maestro: filtros, tabla y sus estados de carga/vacío/error. */
  children: React.ReactNode
  /** Detalle lateral; `null` colapsa la columna y devuelve el ancho al maestro. */
  panel?: React.ReactNode | null
  /** Ancho de la columna de detalle según el tipo de formulario (compacto → wizard). */
  panelSize?: DetailPanelSize
  /**
   * Cómo scrollea la lista con el detalle abierto:
   * - `"panel"` (predeterminado): el group se acota al viewport y la columna
   *   maestra scrollea por dentro. La cabecera y los filtros quedan a la vista.
   * - `"page"`: la lista fluye y crece cuanto necesite, scrollea la página y el
   *   detalle queda pegado al borde superior con el alto del viewport. El panel
   *   y su pie siguen siempre visibles, pero la cabecera y los filtros se van
   *   con el scroll.
   */
  listScroll?: "panel" | "page"
  className?: string
}

/**
 * Lista maestra con detalle lateral sobre `ResizablePanelGroup`: el borde entre
 * columnas se arrastra (y se redimensiona por teclado desde el handle), y el
 * detalle se abre/cierra colapsando su panel, sin remontar el maestro.
 *
 * - Modo `drawer` (<1280px): no hay group; el maestro va a ancho completo y la
 *   página monta el formulario en un `FormDrawer`. `listScroll` no aplica.
 * - Modo `panel` con detalle abierto: el group acota su alto al viewport menos
 *   el padding de la página y cada columna scrollea por dentro, así el detalle
 *   y su footer de acciones quedan siempre a la vista. Es `listScroll="panel"`
 *   (predeterminado).
 * - `listScroll="page"`: el group toma el alto de la lista y la página pasa a
 *   ser el único scroller; el detalle y el handle van `sticky` con el alto del
 *   viewport, así el formulario queda pegado arriba con su pie a la vista
 *   mientras la lista pasa por detrás. En este modo el group suelta el
 *   `overflow: hidden` de la librería —con él, un hijo `sticky` no se despega
 *   del flujo— y la columna maestra deja de scrollear: la cabecera y los
 *   filtros se van con el scroll, que es el precio de que la lista crezca
 *   libre. El corte pegado asume el padding de página de 24px (`p-6`), el mismo
 *   que ya asume el alto de `calc(100dvh - 3rem)`.
 * - Detalle cerrado: el panel colapsa a 0 y el handle se apaga (`w-0` +
 *   `disabled`), así el maestro recupera todo el ancho sin gutter fantasma.
 * - El ancho del detalle lo elige la página con `panelSize`: `md` para
 *   formularios compactos, `lg`/`xl` para formularios de dos columnas o
 *   asistentes (wizard), que a 24rem quedan apretados.
 *
 * Entrada y salida: el detalle se abre y se cierra con el mismo movimiento del
 * drawer (`SLIDE_MS`, la curva del popup), en dos piezas a la vez —la columna
 * crece/decrece y el formulario entra/sale deslizando desde su borde—. Eso fija
 * dos cosas:
 *
 * - El panel de detalle y su contenido existen desde el montaje, colapsados y
 *   `inert` mientras están cerrados. El contenido NO se desmonta al cerrar: sin
 *   un estado de partida no hay nada que animar, y el formulario aparecería ya
 *   en su sitio. `panel={null}` de la página significa «colapsado», no
 *   «desmontado»; lo que la página decide con esa prop es qué formulario pasa,
 *   y el último que pasó es el que sobrevive colapsado.
 * - La transición de ancho se enciende solo alrededor del cambio programático
 *   (`data-animating`) y se apaga en el primer `pointerdown` del handle: si
 *   estuviera siempre activa, el arrastre iría 450ms por detrás del puntero.
 *   La librería no expone `onResizeStart`, así que esa es la única señal
 *   sincrónica disponible.
 *
 * Con `prefers-reduced-motion: reduce` no se anima nada: ni el ancho ni el
 * deslizamiento.
 *
 * Con columna lateral en el layout (`SideDockProvider`), el detalle no va en
 * un group dentro de la página: se monta en esa columna, a todo el alto de la
 * ventana y pegado al borde derecho, igual que el panel del agente. La lista
 * queda como en modo `drawer` (ancho completo, scroll de página) y
 * `listScroll` no aplica. El detalle se desmonta al cerrar.
 */
export function MasterDetail({
  children,
  panel,
  panelSize = "md",
  listScroll = "panel",
  className,
}: MasterDetailProps) {
  const mode = useDetailMode()
  const dock = useSideDock()
  const [dockWidth, resizeDock] = useSideColumnWidth(
    `odentia.side-panel.${panelSize}`,
    DOCK_SIZES[panelSize],
  )
  const open = panel != null
  const pageScroll = listScroll === "page"
  const size = PANEL_SIZES[panelSize]
  const detailRef = usePanelRef()
  const groupRef = React.useRef<HTMLDivElement | null>(null)
  const detailContentRef = React.useRef<HTMLDivElement>(null)
  const handleRef = React.useRef<HTMLDivElement>(null)
  const returnFocusRef = React.useRef<HTMLElement | null>(null)
  const reduceMotion = usePrefersReducedMotion()
  // El contenido sobrevive al cierre: su último valor es el que queda colapsado
  // e `inert`, y de donde sale la animación de entrada la próxima vez.
  const lastPanel = React.useRef<React.ReactNode>(null)
  if (panel != null) lastPanel.current = panel

  // La transición solo se enciende alrededor del cambio programático: dejarla
  // activa haría que el arrastre vaya 450ms por detrás del puntero.
  const markAnimating = React.useCallback(() => {
    const group = groupRef.current
    if (!group || reduceMotion) return
    group.dataset.animating = "true"
    window.setTimeout(() => {
      group.dataset.animating = "false"
    }, SLIDE_MS)
  }, [reduceMotion])

  // Ancho con el que se abre el detalle: el que pide la página (`panelSize`) y,
  // después, el que el usuario dejó con el arrastre. Hace falta recordarlo
  // porque `expand()` no sirve cuando el panel nace colapsado por
  // `defaultLayout`: sin tamaño previo registrado cae al mínimo (`minSize`) y el
  // formulario se abriría más angosto de lo que pidió la página.
  const openSize = React.useRef<string | number>(size.default)
  React.useEffect(() => {
    openSize.current = size.default
  }, [size.default])

  // Expandir/colapsar sin remontar: la librería ajusta el tamaño imperativamente.
  // La animación se decide por el estado real del panel, no por «primera
  // pasada»: el handle se publica recién después del primer layout, así que
  // cualquier contador se consumiría en la apertura en vez del montaje.
  React.useLayoutEffect(() => {
    const detail = detailRef.current
    if (!detail) return
    if (detail.isCollapsed() === !open) return
    markAnimating()
    if (open) {
      detail.resize(openSize.current)
      return
    }
    const { inPixels } = detail.getSize()
    if (inPixels > 0) openSize.current = inPixels
    detail.collapse()
  }, [open, detailRef, markAnimating])

  // El detalle cerrado permanece montado e inert: el retorno depende de open,
  // no del desmontaje del formulario.
  React.useLayoutEffect(() => {
    if (mode !== "panel") return
    const active = document.activeElement
    const inside =
      active != null && (detailContentRef.current?.contains(active) || active === handleRef.current)
    if (open) {
      if (active instanceof HTMLElement && active !== document.body && !inside) {
        returnFocusRef.current = active
      }
    } else {
      if ((active === document.body || inside) && returnFocusRef.current?.isConnected) {
        returnFocusRef.current.focus()
      }
      returnFocusRef.current = null
    }
  }, [mode, open])

  if (mode === "drawer" || dock.available) {
    return (
      <>
        <div className={cn("flex min-w-0 flex-col gap-6", className)}>{children}</div>
        {mode === "panel" && open ? (
          <SideDockPortal
            // Columna ocupada por otro detalle: este sale como cajón. Lo cierran
            // los controles del propio formulario (la página no sabe que cayó
            // aquí), por eso el cajón no se descarta por fuera.
            fallback={
              <Drawer open swipeDirection="right" disablePointerDismissal>
                <DrawerContent aria-label={common.sidePanel.label}>
                  <SideDockScopeProvider value="overlay">{panel}</SideDockScopeProvider>
                </DrawerContent>
              </Drawer>
            }
          >
            <SideColumn
              aria-label={common.sidePanel.label}
              width={dockWidth}
              onResize={resizeDock}
              bounds={DOCK_SIZES[panelSize]}
              pageMinWidth={MASTER_MIN_WIDTH}
              resizeLabel={common.sidePanel.resize}
            >
              <div ref={detailContentRef} className="flex h-full min-h-0 flex-col">
                {panel}
              </div>
            </SideColumn>
          </SideDockPortal>
        ) : null}
      </>
    )
  }

  return (
    <ResizablePanelGroup
      elementRef={groupRef}
      orientation="horizontal"
      // El detalle nace colapsado en el layout inicial: en la primera medición
      // el group pasa de alto automático a alto de viewport y la librería
      // recompone el layout desde `defaultSize`, así que un `collapse()` de
      // arranque no sobrevive (deja la columna vacía). `defaultLayout` fija ese
      // primer layout para que la primera aparición tenga de dónde animar.
      defaultLayout={open ? undefined : { master: 100, detail: 0 }}
      // Por `style` y no por clase: el wrapper trae `h-full` de base y el merge
      // de clases no garantiza que gane el alto fijo; la librería solo bloquea
      // display/flex-direction/flex-wrap/overflow, así que `height` es nuestro.
      // Con scroll de página el alto lo pone la lista y el group suelta su
      // `overflow: hidden`: con él, el detalle `sticky` queda encerrado y no se
      // despega. La alineación se deja en `stretch` (predeterminada) a
      // propósito: así la caja de cada columna abarca el alto de la lista y la
      // tarjeta pegada tiene recorrido dentro de ella.
      style={{
        height: open && !pageScroll ? "calc(100dvh - 3rem)" : "auto",
        ...(pageScroll ? { overflow: "visible" } : {}),
      }}
      className={cn(ANCHO_ANIMADO, className)}
    >
      <ResizablePanel
        id="master"
        minSize="32rem"
        className={cn(
          "flex h-full min-w-0 flex-col gap-6",
          // Con scroll de página la lista crece y scrollea la página: la barra
          // propia de la columna competiría con aquella. El mínimo la deja del
          // alto del detalle pegado, así una lista corta no deja la tarjeta
          // salida del group.
          pageScroll ? "min-h-[calc(100dvh-3rem)]" : "overflow-y-auto",
        )}
      >
        {children}
      </ResizablePanel>
      <ResizableHandle
        elementRef={handleRef}
        withHandle
        disabled={!open}
        // El arrastre manda: apaga la transición en su primer cuadro.
        onPointerDown={() => {
          const group = groupRef.current
          if (group) group.dataset.animating = "false"
        }}
        className={cn(
          "w-6 bg-transparent",
          !open && "w-0 overflow-hidden",
          // El handle acompaña al detalle pegado: sin esto se estiraría a todo
          // el alto de la lista.
          pageScroll && open && "sticky top-6 h-[calc(100dvh-3rem)]",
        )}
      />
      <ResizablePanel
        id="detail"
        panelRef={detailRef}
        collapsible
        collapsedSize={0}
        defaultSize={size.default}
        minSize={size.min}
        maxSize={size.max}
        // La librería monta el alto en la caja de la columna y deja el
        // `className` en el envoltorio de adentro: el `sticky` va ahí, dentro de
        // una caja que abarca la lista entera.
        className={cn(
          "min-w-0",
          pageScroll && open ? "sticky top-6 h-[calc(100dvh-3rem)]" : "h-full",
        )}
      >
        {/* La caja recorta el deslizamiento: sin ella, mover el formulario
            agrandaría el área scrolleable del panel (barra horizontal). */}
        <div className="relative h-full overflow-hidden">
          <div
            ref={detailContentRef}
            data-open={open ? "" : undefined}
            data-closed={open ? undefined : ""}
            inert={!open ? true : undefined}
            className={CONTENIDO_ANIMADO}
          >
            {panel ?? lastPanel.current}
          </div>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
