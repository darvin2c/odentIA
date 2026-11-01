import { Drawer, DrawerContent, useIsMobile } from "@odentia/ui"
import { SideColumn, SideDockSlot, useMediaQuery, useSideColumnWidth, useSideDock, useSidebarWidth } from "@odentia/ui-patterns"
import { useRouterState } from "@tanstack/react-router"
import { createContext, type ReactNode, type RefObject, useCallback, useContext, useEffect, useRef, useState } from "react"

/**
 * La columna de los Avisos de la campana: en pantalla grande va fija a la
 * derecha y la página sigue usable al lado; cuando no cabe se superpone, sin
 * cerrar la página ni sus borradores, con el mismo cajón que los formularios:
 * lateral en escritorio y hoja inferior con asa en móvil.
 *
 * El layout de la organización la monta una sola vez, junto al `SideDockSlot`
 * de los formularios: la página nunca se remonta al abrirla o cerrarla.
 */

/** Marco que recibe el contenido de Avisos: el mismo de la columna o del cajón. */
export interface NoticesFrame {
  /** Dentro del cajón: título y descripción son los del diálogo. */
  overlay: boolean
  onClose: () => void
}

/**
 * Desde este ancho la columna (384 px) cabe junto a la página con el sidebar
 * abierto; por debajo se superpone como cajón.
 */
const DOCK_QUERY = "(min-width: 1536px)"
/** Ancho mínimo que la columna deja a la página (lista y hilo de la Bandeja). */
const PAGE_MIN_WIDTH = 848
/** Ancho que necesita la Bandeja para mostrar además «Contexto». */
const PAGE_WITH_CONTEXT_WIDTH = 1248
const COLUMN_ID = "columna-de-avisos"
/** Ancho de la columna en px: ajustable con el tirador y recordado en este navegador. */
const DOCK_WIDTH = { initial: 384, min: 320, max: 640 }
const DOCK_WIDTH_KEY = "odentia.notices-column.width"

interface NoticesColumnState {
  open: boolean
  /** Abierta como columna fija: la página sigue usable al lado. */
  docked: boolean
  /** Ancho elegido para la columna, en px. */
  dockWidth: number
  setDockWidth: (width: number) => void
  setOpen: (open: boolean) => void
  /** Contenido de Avisos, que aporta el layout. */
  notices: ((frame: NoticesFrame) => ReactNode) | undefined
  /** Control desde el que se abrió: recibe el foco al cerrar. */
  openerRef: RefObject<HTMLElement | null>
  /** Páginas que ahora mismo piden cajón en vez de columna. */
  dockBlockers: RefObject<number>
}

const NoticesColumnContext = createContext<NoticesColumnState>({
  open: false,
  docked: false,
  dockWidth: DOCK_WIDTH.initial,
  setDockWidth: () => {},
  setOpen: () => {},
  notices: undefined,
  openerRef: { current: null },
  dockBlockers: { current: 0 },
})

/**
 * La campana y lo que comparte el sitio con los Avisos: si están abiertos, si
 * ocupan la columna y cómo abrirlos o cerrarlos. La Bandeja le cede «Contexto».
 */
export function useNoticesColumn(): Pick<NoticesColumnState, "open" | "docked" | "setOpen"> {
  const { open, docked, setOpen } = useContext(NoticesColumnContext)
  return { open, docked, setOpen }
}

/** La Bandeja pregunta si, con la columna a su ancho actual, cabe además «Contexto». */
export function useNoticesColumnFitsBesideContext(): boolean {
  const { dockWidth } = useContext(NoticesColumnContext)
  const sidebar = useSidebarWidth()
  return useMediaQuery(`(min-width: ${sidebar + PAGE_WITH_CONTEXT_WIDTH + dockWidth}px)`)
}

/**
 * Mientras `blocked`, los Avisos se abren como cajón aunque quepan como columna:
 * la página tiene a la derecha algo que la columna desplazaría y que no debe
 * desmontarse (un borrador sin guardar).
 */
export function useNoticesColumnDockBlocker(blocked: boolean): void {
  const { dockBlockers } = useContext(NoticesColumnContext)
  useEffect(() => {
    if (!blocked) return
    dockBlockers.current += 1
    return () => {
      dockBlockers.current -= 1
    }
  }, [blocked, dockBlockers])
}

export function NoticesColumnProvider({
  children,
  notices,
}: {
  children: ReactNode
  /** Contenido de Avisos; sin él, la campana no tiene dónde abrirse. */
  notices?: (frame: NoticesFrame) => ReactNode
}) {
  const [open, setOpenState] = useState(false)
  const openerRef = useRef<HTMLElement | null>(null)
  const dockBlockers = useRef(0)
  const wide = useMediaQuery(DOCK_QUERY)
  const wideRef = useRef(wide)
  wideRef.current = wide
  // La presentación se decide al abrir y no cambia sola (salvo que la ventana
  // se estreche): pasar de cajón a columna a mitad de una tarea desmontaría lo
  // que se estaba mirando.
  const [docked, setDocked] = useState(false)
  const dockedRef = useRef(docked)
  dockedRef.current = docked
  const [dockWidth, setDockWidth] = useSideColumnWidth(DOCK_WIDTH_KEY, DOCK_WIDTH)
  // La columna del layout es una sola: si una página ya tiene ahí un formulario
  // o un detalle, los Avisos se abren como cajón; y si lo abre con los Avisos en
  // la columna, le ceden el sitio.
  const { occupied } = useSideDock()
  const occupiedRef = useRef(occupied)
  occupiedRef.current = occupied
  const openRef = useRef(open)
  openRef.current = open
  const setOpen = useCallback((next: boolean) => {
    if (next) {
      const active = document.activeElement
      const inColumn = active instanceof HTMLElement && active.closest(`#${COLUMN_ID}`) !== null
      if (!inColumn) {
        openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null
      }
      if (!openRef.current) setDocked(wideRef.current && dockBlockers.current === 0 && !occupiedRef.current)
    }
    setOpenState(next)
  }, [])
  useEffect(() => {
    if (!wide) setDocked(false)
  }, [wide])
  useEffect(() => {
    if (occupied && dockedRef.current) setOpenState(false)
  }, [occupied])
  // Los enlaces de un aviso no lo cierran al clic: si la página protege un
  // borrador y el usuario elige seguir editando, sigue tal cual. El cajón se
  // cierra cuando la navegación se confirma (cambia la ubicación); la columna
  // fija no tapa la página y acompaña la navegación.
  const href = useRouterState({ select: (state) => state.location.href })
  const lastHref = useRef(href)
  useEffect(() => {
    if (lastHref.current !== href) {
      lastHref.current = href
      if (!dockedRef.current) setOpen(false)
    }
  }, [href, setOpen])
  return (
    <NoticesColumnContext.Provider value={{ open, docked, dockWidth, setDockWidth, setOpen, notices, openerRef, dockBlockers }}>
      {/* La estructura no cambia al abrir o cerrar: la página nunca se remonta. */}
      <div className="flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        <SideDockSlot />
        <DockedNotices />
      </div>
      <NoticesDrawer />
    </NoticesColumnContext.Provider>
  )
}

/**
 * Cajón: cuando no cabe como columna, y siempre en móvil. Mismo contenedor y
 * gestos que `FormDrawer`, para que todo lo que se superpone a la página se
 * abra y se cierre igual.
 */
function NoticesDrawer() {
  const { open, docked, setOpen, notices, openerRef } = useContext(NoticesColumnContext)
  const isMobile = useIsMobile()
  const shown = open && !docked
  return (
    <Drawer open={shown} swipeDirection={isMobile ? "down" : "right"} showSwipeHandle={isMobile} onOpenChange={setOpen}>
      <DrawerContent
        id={shown ? COLUMN_ID : undefined}
        finalFocus={() => (openerRef.current?.isConnected ? openerRef.current : null)}
        className="data-[swipe-axis=y]:[--drawer-content-height:calc(100dvh-1rem-env(safe-area-inset-top))] data-[swipe-axis=y]:[--drawer-content-max-height:calc(100dvh-1rem-env(safe-area-inset-top))]"
        aria-label="Avisos"
      >
        {notices?.({ overlay: true, onClose: () => setOpen(false) })}
      </DrawerContent>
    </Drawer>
  )
}

/** Columna fija a la derecha: no es modal, la página sigue usable al lado. */
function DockedNotices() {
  const { open, docked, setOpen, notices, openerRef, dockWidth: width, setDockWidth: resize } = useContext(NoticesColumnContext)
  const shown = open && docked && notices !== undefined
  const ref = useRef<HTMLElement | null>(null)
  // Al abrir, el foco entra en la columna: queda después de la página en el
  // orden de tabulación y quien usa teclado no debe recorrerla entera.
  useEffect(() => {
    if (shown) ref.current?.focus({ preventScroll: true })
  }, [shown])
  if (!shown) return null
  const close = () => {
    const target = openerRef.current?.isConnected ? openerRef.current : null
    setOpen(false)
    // Tras el repintado: lo que la página vuelve a mostrar al cerrar (el
    // «Contexto» de la Bandeja enfoca su título al montarse) no se queda el foco.
    requestAnimationFrame(() => target?.focus())
  }
  return (
    <SideColumn
      ref={ref}
      id={COLUMN_ID}
      aria-label="Avisos"
      tabIndex={-1}
      width={width}
      onResize={resize}
      bounds={DOCK_WIDTH}
      // La página conserva lo que necesitan la lista y el hilo de la Bandeja.
      pageMinWidth={PAGE_MIN_WIDTH}
      resizeLabel="Ancho de los avisos"
      onKeyDown={(event) => {
        // Solo Esc pulsado dentro de la columna; los diálogos que abre viven en un portal.
        if (event.key !== "Escape" || event.defaultPrevented) return
        if (!event.currentTarget.contains(event.target as Node)) return
        close()
      }}
    >
      {notices?.({ overlay: false, onClose: close })}
    </SideColumn>
  )
}
