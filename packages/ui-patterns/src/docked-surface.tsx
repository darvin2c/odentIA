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
import { SUBMIT_REJECTED_EVENT } from "./form/submit-outcome.js"
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

/**
 * Lo que el contenedor (la columna o un cajón) ofrece a su contenido: decir cómo quedó lo
 * escrito, enterarse de «Descartar y salir» y retirarse al cerrarse.
 */
interface DraftSavedChannel {
  report: (saved: boolean, lost?: string | null) => void
  release: () => void
  onDiscard: (listener: () => void) => () => void
  onSaved: (listener: () => void) => () => void
}

const DraftSavedContext = React.createContext<DraftSavedChannel | null>(null)
const nothingToTell = () => {}

/** Lo que un contenedor sabe de lo que su contenido guarda solo. */
export interface DraftSavedScope {
  channel: DraftSavedChannel
  /** Hay algo que no se guardó (un error, un valor que no vale): cerrar o salir pregunta. */
  unsaved: boolean
  /** Qué se pierde, en palabras de quien decide; `null` si quien avisa no lo dijo. */
  lost: string | null
  /** «Descartar y salir»: lo que estaba por guardarse ya no se guarda al cerrarse. */
  discard: () => void
}

/**
 * El estado de «salir sin guardar» que el contenido de un contenedor le cuenta con
 * `useDraftSaved`. Lo crea cada contenedor (`FormDrawer`, `DetailDrawer`), que lo usa en su
 * cierre (×, Escape) y, en la columna, también al salir por el menú: los tres preguntan igual.
 */
export function useDraftSavedScope(): DraftSavedScope {
  const [state, setState] = React.useState<{ unsaved: boolean; lost: string | null }>({ unsaved: false, lost: null })
  const discarders = React.useRef(new Set<() => void>())
  const savers = React.useRef(new Set<() => void>())
  const channel = React.useMemo<DraftSavedChannel>(
    () => ({
      report: (saved, lost = null) => {
        const next = { unsaved: !saved, lost: saved ? null : lost }
        setState((current) => (current.unsaved === next.unsaved && current.lost === next.lost ? current : next))
        if (saved) for (const listener of savers.current) listener()
      },
      // Quien avisaba se cerró y el contenedor sigue con otra cosa: lo suyo ya no está para perderse.
      release: () => setState({ unsaved: false, lost: null }),
      onDiscard: (listener) => {
        discarders.current.add(listener)
        return () => discarders.current.delete(listener)
      },
      onSaved: (listener) => {
        savers.current.add(listener)
        return () => savers.current.delete(listener)
      },
    }),
    [],
  )
  const discard = React.useCallback(() => {
    for (const listener of discarders.current) listener()
  }, [])
  return { channel, unsaved: state.unsaved, lost: state.lost, discard }
}

/** El contenido de un cajón le habla a su cajón (lo pone el contenedor). */
export function DraftSavedProvider({ scope, children }: { scope: DraftSavedScope; children: React.ReactNode }) {
  return <DraftSavedContext.Provider value={scope.channel}>{children}</DraftSavedContext.Provider>
}

/**
 * Para una superficie que guarda sin `submit` (un autoguardado, una nota que se agrega con su
 * botón): le dice a su contenedor cómo quedó lo escrito. `true`, ya está guardado (o se guardará
 * al cerrarse): no hay nada que perder y salir no pregunta hasta que se vuelva a escribir.
 * `false`, hay algo que no se guardó: cerrar con ×, con Escape o salir por el menú preguntan,
 * con `lost` diciendo qué se pierde. `onDiscard` se llama si la persona elige «Descartar y
 * salir», antes de cerrarse: lo pendiente ya no debe guardarse.
 *
 * Habla con el contenedor más cercano: lo que se abre desde la columna es un cajón aparte
 * (regla 2 de `side-dock`) con su propio aviso, y su «guardado» no desarma el de la columna. Al
 * quitarse quien lo usa, el contenedor deja de avisar por él.
 */
export function useDraftSaved(options: { onDiscard?: () => void } = {}): (saved: boolean, lost?: string | null) => void {
  const channel = React.useContext(DraftSavedContext)
  const onDiscard = React.useRef(options.onDiscard)
  onDiscard.current = options.onDiscard
  React.useEffect(() => {
    if (!channel) return
    const off = channel.onDiscard(() => onDiscard.current?.())
    return () => {
      off()
      channel.release()
    }
  }, [channel])
  return channel?.report ?? nothingToTell
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
  /** Lo que el contenido guarda solo (`useDraftSavedScope` del contenedor, que lo usa también en su cierre). */
  draft?: DraftSavedScope
  children: React.ReactNode
}

/**
 * Superficie en la columna lateral del layout. No es modal, así que aporta lo
 * que el cajón daba gratis: lleva el foco a la columna al abrir, lo devuelve al
 * control que la abrió al cerrar y protege los cambios sin guardar frente a la
 * navegación (la página sigue usable al lado).
 */
export function DockedSurface({ bounds, dirty = false, fallback, draft, children }: DockedSurfaceProps) {
  return (
    <SideDockPortal fallback={fallback}>
      <DockedColumn bounds={bounds} dirty={dirty} draft={draft}>
        {children}
      </DockedColumn>
    </SideDockPortal>
  )
}

function DockedColumn({
  bounds,
  dirty,
  draft: given,
  children,
}: Pick<DockedSurfaceProps, "bounds" | "children" | "draft"> & { dirty: boolean }) {
  const [width, resize] = useSideColumnWidth(sidePanelWidthKey(bounds), bounds)
  const DraftGuard = useSideDockDraftGuard()
  const keptInPage = useDraftKeptInPage()
  const ref = React.useRef<HTMLElement | null>(null)
  // Muchas pantallas no informan `isDirty` (en un cajón modal no hacía falta):
  // haber escrito algo aquí dentro ya cuenta como cambios pendientes.
  // Enviar el formulario desarma el aviso: tras guardar, la pantalla suele
  // navegar al registro creado y eso no es «salir sin guardar». Si el envío no
  // pasa (falta un dato, el servidor lo rechaza), lo escrito sigue sin guardar y
  // el aviso se vuelve a armar; también al escribir otra vez.
  const [touched, setTouched] = React.useState(false)
  const [armed, setArmed] = React.useState(true)
  const content = React.useRef<HTMLDivElement | null>(null)
  const submitted = React.useRef(false)
  React.useEffect(() => {
    const element = content.current
    if (!element) return
    const rejected = () => {
      if (!submitted.current) return
      submitted.current = false
      setArmed(true)
      setTouched(true)
    }
    element.addEventListener(SUBMIT_REJECTED_EVENT, rejected)
    return () => element.removeEventListener(SUBMIT_REJECTED_EVENT, rejected)
  }, [])
  // Lo que guarda sin `submit` lo dice la propia superficie (`useDraftSaved`).
  const own = useDraftSavedScope()
  const draft = given ?? own
  // «Ya está guardado» desarma lo que se contaba por las teclas.
  React.useEffect(() => draft.channel.onSaved(() => setTouched(false)), [draft.channel])

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

  const typed = armed && (dirty || touched)
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
        ref={content}
        className="flex h-full min-h-0 flex-col"
        onSubmitCapture={(event) => {
          // Un cajón abierto desde aquí vive en un portal: su envío no habla por lo de la columna.
          if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return
          submitted.current = true
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
        <DraftSavedContext.Provider value={draft.channel}>{children}</DraftSavedContext.Provider>
      </div>
      {DraftGuard ? (
        <DraftGuard
          dirty={draft.unsaved || typed}
          // Si lo único que falta es lo que el contenido dijo, se dice qué es.
          lost={draft.unsaved && !typed ? draft.lost : null}
          onDiscard={draft.discard}
          keptInPage={keptInPage}
        />
      ) : null}
    </SideColumn>
  )
}
