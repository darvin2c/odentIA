import * as React from "react"
import { common } from "./common.js"
import { DOCK_SIZES, detailPanelFits, MASTER_MIN_WIDTH } from "./master-detail.js"
import {
  SideColumn,
  type SideColumnWidth,
  SideDockPortal,
  sidePanelWidthKey,
  useDraftKeptInPage,
  useSideColumnWidth,
  useSideDock,
  useSideDockDraftGuard,
  useSideDockScope,
} from "./side-dock.js"
import { OPEN_POPUP_SELECTOR } from "./surface.js"

/**
 * Controles que cambian un valor sin emitir `input` (desplegables, casillas,
 * interruptores de Base UI). Sus listas viven en un portal, pero el evento de
 * React sube igual por el árbol hasta la columna.
 */
const CHOICE_SELECTOR =
  "[role=option],[role=checkbox],[role=switch],[role=radio],[role=menuitemcheckbox],[role=menuitemradio]"

/**
 * `data-draft-ignore`: una casilla que solo acompaña a la acción del pie (no es un dato que se
 * pierda al salir) no arma el aviso de «salir sin guardar».
 */
function isChoice(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const choice = target.closest(CHOICE_SELECTOR)
  // Una opción apagada no cambia nada al tocarla (un formulario que solo se lee).
  if (choice === null || choice.matches(":disabled, [aria-disabled=true], [data-disabled]")) return false
  return target.closest("[data-draft-ignore]") === null
}

const DraftSavedContext = React.createContext<(saved: boolean) => void>(() => {})

/**
 * Para una superficie que guarda sin `submit` (un autoguardado, una nota que se agrega con su
 * botón): le dice a la columna cómo quedó lo escrito. `true`, ya está guardado: el aviso de
 * «salir sin guardar» se desarma hasta que se vuelva a escribir. `false`, hay algo que no se
 * guardó: avisa aunque el cambio no haya sido una tecla. Fuera de la columna no hace nada: en
 * un cajón el aviso es el del propio cajón (`isDirty`).
 */
export function useDraftSaved(): (saved: boolean) => void {
  return React.useContext(DraftSavedContext)
}

/** Un cajón más ancho que esto es una vista inmersiva (visor, comparador): no va a la columna. */
const MAX_DOCKED_WIDTH = 672

/**
 * Ancho de la columna a partir del ancho que la pantalla pidió para su cajón
 * (`--drawer-content-width:min(42rem, …)`), para que el formulario mida lo
 * mismo en los dos contenedores. `null`: demasiado ancho para la columna.
 */
function boundsFromDrawerClass(className: string | undefined): SideColumnWidth | null {
  const rem = className?.match(/--drawer-content-width:min\((\d+)rem/)?.[1]
  if (!rem) return DOCK_SIZES.md
  const width = Number(rem) * 16
  if (width > MAX_DOCKED_WIDTH) return null
  return { initial: width, min: Math.max(320, width - 160) }
}

/**
 * Decide, en el momento de abrir, si una superficie va a la columna lateral del
 * layout o se queda en cajón, y lo mantiene hasta que se cierra: cambiar de
 * contenedor a mitad de una edición remontaría el formulario.
 *
 * Va a la columna solo si el layout la ofrece, la ventana da para lista y
 * detalle, se abre desde la página (no desde la columna ni desde un cajón) y
 * no hay ningún diálogo abierto. Devuelve el ancho de la columna o `null`.
 */
export function useDockDecision(
  open: boolean,
  options: { className?: string; bounds?: SideColumnWidth; disabled?: boolean } = {},
): SideColumnWidth | null {
  const dock = useSideDock()
  const scope = useSideDockScope()
  const decision = React.useRef<SideColumnWidth | null>(null)
  const wasOpen = React.useRef(false)
  if (open && !wasOpen.current) {
    const fits =
      !options.disabled &&
      dock.available &&
      scope === "page" &&
      typeof document !== "undefined" &&
      detailPanelFits() &&
      document.querySelector(OPEN_POPUP_SELECTOR) === null
    decision.current = fits ? (options.bounds ?? boundsFromDrawerClass(options.className)) : null
  }
  if (!open) decision.current = null
  wasOpen.current = open
  return decision.current
}

export interface DockedSurfaceProps {
  bounds: SideColumnWidth
  /** Cambios sin guardar: navegar a otra pantalla pregunta antes. */
  dirty?: boolean
  /** La misma superficie en cajón, por si la columna ya está ocupada. */
  fallback: React.ReactNode
  children: React.ReactNode
}

/**
 * Superficie en la columna lateral del layout. No es modal, así que aporta lo
 * que el cajón daba gratis: lleva el foco a la columna al abrir, lo devuelve al
 * control que la abrió al cerrar y protege los cambios sin guardar frente a la
 * navegación (la página sigue usable al lado).
 */
export function DockedSurface({ bounds, dirty = false, fallback, children }: DockedSurfaceProps) {
  return (
    <SideDockPortal fallback={fallback}>
      <DockedColumn bounds={bounds} dirty={dirty}>
        {children}
      </DockedColumn>
    </SideDockPortal>
  )
}

function DockedColumn({
  bounds,
  dirty,
  children,
}: Pick<DockedSurfaceProps, "bounds" | "children"> & { dirty: boolean }) {
  const [width, resize] = useSideColumnWidth(sidePanelWidthKey(bounds), bounds)
  const DraftGuard = useSideDockDraftGuard()
  const keptInPage = useDraftKeptInPage()
  const ref = React.useRef<HTMLElement | null>(null)
  // Muchas pantallas no informan `isDirty` (en un cajón modal no hacía falta):
  // haber escrito algo aquí dentro ya cuenta como cambios pendientes.
  // Enviar el formulario desarma el aviso: tras guardar, la pantalla suele
  // navegar al registro creado y eso no es «salir sin guardar». Volver a
  // escribir lo arma otra vez (p. ej. tras un error de validación).
  const [touched, setTouched] = React.useState(false)
  const [armed, setArmed] = React.useState(true)
  // Lo que guarda sin `submit` lo dice la propia superficie (`useDraftSaved`).
  const [unsaved, setUnsaved] = React.useState(false)
  const draftSaved = React.useCallback((saved: boolean) => {
    setUnsaved(!saved)
    if (saved) setTouched(false)
  }, [])

  // Quién la abrió se anota al renderizar, antes de que un campo con
  // `autoFocus` del formulario tome el foco y pase por ser el que la abrió.
  const [opener] = React.useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null
    const active = document.activeElement
    return active instanceof HTMLElement && active !== document.body ? active : null
  })
  React.useLayoutEffect(() => {
    const column = ref.current
    column?.focus({ preventScroll: true })
    return () => {
      const current = document.activeElement
      const lost = current === null || current === document.body || column?.contains(current)
      if (lost && opener?.isConnected) {
        opener.focus()
        return
      }
      // Si se cierra desde «¿Salir sin guardar?», el foco está en esa pregunta y
      // cae al `body` cuando ella también se va: se comprueba de nuevo después.
      requestAnimationFrame(() => {
        const after = document.activeElement
        if ((after === null || after === document.body) && opener?.isConnected) opener.focus()
      })
    }
  }, [opener])

  return (
    <SideColumn
      ref={ref}
      tabIndex={-1}
      aria-label={common.sidePanel.label}
      width={width}
      onResize={resize}
      bounds={bounds}
      pageMinWidth={MASTER_MIN_WIDTH}
      resizeLabel={common.sidePanel.resize}
    >
      <div
        className="flex h-full min-h-0 flex-col"
        onSubmitCapture={() => {
          setArmed(false)
          setTouched(false)
        }}
        onInputCapture={(event) => {
          if (event.target instanceof Element && event.target.closest("[data-draft-ignore]")) return
          setArmed(true)
          setTouched(true)
        }}
        onClickCapture={(event) => {
          if (!isChoice(event.target)) return
          setArmed(true)
          setTouched(true)
        }}
        onKeyDownCapture={(event) => {
          if ((event.key !== "Enter" && event.key !== " ") || !isChoice(event.target)) return
          setArmed(true)
          setTouched(true)
        }}
      >
        <DraftSavedContext.Provider value={draftSaved}>{children}</DraftSavedContext.Provider>
      </div>
      {DraftGuard ? <DraftGuard dirty={unsaved || (armed && (dirty || touched))} keptInPage={keptInPage} /> : null}
    </SideColumn>
  )
}
