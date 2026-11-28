/**
 * Mantener y arrastrar a un destino discreto: un día, una franja o un recurso
 * (no un minuto, como la rejilla). Usa el mismo núcleo que la agenda
 * (`useEntryDrag`): mantener 400 ms con el dedo o arrastrar con el mouse tras
 * 4 px; un toque sigue siendo un toque y el desplazamiento normal no se toca
 * hasta que se mantiene el dedo quieto. Con el teclado, Alt+Intro levanta, las
 * flechas eligen el destino, Intro suelta y Escape cancela.
 *
 * Al soltar no se mueve nada: avisa `onDrop(id, destino)` y quien lo usa abre
 * lo suyo (el cajón con «Pasar a…» ya lleno), donde se confirma. Soltar donde
 * ya estaba, fuera de un destino o sobre una flecha no avisa nada. Arrastrar
 * nunca es la única forma de mover algo: la pantalla ofrece la misma acción
 * en su cajón.
 *
 * Las piezas: `ScheduleDropProvider` envuelve la pantalla; lo que se arrastra
 * recibe las props de `useScheduleDraggable`; cada destino, las de
 * `useScheduleDropTarget`. `ScheduleDayStrip` hace de cada día un destino, y
 * `ScheduleStepArrow` pasa de semana si se queda encima.
 *
 * Lo que cambia mientras se arrastra (qué se levanta, qué está debajo) vive en
 * un almacén pequeño: cada tarjeta y cada destino se vuelve a pintar solo
 * cuando cambia lo suyo, no a cada movimiento del dedo.
 */

import { Button, cn } from "@odentia/ui"
import { ChevronLeft, ChevronRight } from "lucide-react"
import * as React from "react"

import { type DragEntry, type DragGeometry, DragLiveRegion, TOUCH_CANCEL_PX, useEntryDrag } from "./drag.js"

/**
 * Un destino. Lo que no dice (`undefined`) no cambia; `null` es «ninguno»
 * (sin franja, sin repartidor).
 */
export interface ScheduleDropTarget {
  /** El día, ISO 8601 («2026-11-28»). */
  date?: string
  /** La franja del día («tarde»). */
  slot?: string | null
  /** El recurso: un repartidor, un profesional, un consultorio. */
  resourceId?: string | null
}

export interface ScheduleDraggableItem extends DragEntry {
  /** Cómo se dice en voz alta: «Carla Mendoza, pedido 0164». */
  title: string
  /** Dónde está ahora: soltarlo ahí (o en algo que no dice otra cosa) no avisa nada. */
  from?: ScheduleDropTarget
  /** Lo que sigue al dedo: una versión corta de la tarjeta. Sin esto, su nombre. */
  ghost?: () => React.ReactNode
  /** No se levanta (ya salió, o el rol no mueve nada). */
  disabled?: boolean
}

/**
 * Las props de lo que se arrastra: van en el elemento que lo contiene (la
 * tarjeta). `data-dragging` y `data-lifting` sirven para pintarlo.
 */
export interface ScheduleDraggableProps {
  onPointerDown?: (event: React.PointerEvent) => void
  onKeyDown?: (event: React.KeyboardEvent) => void
  onBlur?: (event: React.FocusEvent) => void
  onClickCapture?: (event: React.MouseEvent) => void
  onContextMenu?: (event: React.MouseEvent) => void
  "data-dragging"?: "true"
  "data-lifting"?: "true"
}

export interface ScheduleDropProviderProps {
  children: React.ReactNode
  /** Al soltar en otro destino. No mueve nada: abre lo suyo, donde se confirma. */
  onDrop: (itemId: string, target: ScheduleDropTarget) => void
  /** Cómo se dice un destino en voz alta: «viernes 28, tarde, Kevin». */
  describe: (target: ScheduleDropTarget) => string
  /** Lo que se oye al levantar, tras «Moviendo …»: dónde se puede soltar. */
  hint?: string
  /** Nada se arrastra (un rol que no mueve entregas). */
  disabled?: boolean
  /** Lo que se desplaza al acercarse a su borde; por defecto, la página. */
  scrollContainer?: () => HTMLElement | null
}

/** Fuera de todo destino. No vacío: el núcleo no cambia de destino con un valor falso. */
const NONE = "-"
/** Cuánto hay que quedarse sobre una flecha para que pase de semana. */
const STEP_WAIT_MS = 650
const DEFAULT_HINT = "Suéltalo sobre un día, una franja o una persona."
const NOTHING_MOVED = "No se movió nada."
const pageScroll = () => document.scrollingElement as HTMLElement | null

/** La clave de un destino: el orden de los campos es fijo y `undefined` no se escribe. */
function dropKey(target: ScheduleDropTarget): string {
  return JSON.stringify({ date: target.date, slot: target.slot, resourceId: target.resourceId })
}

/** Cada flecha, la suya: con dos franjas en la pantalla, quedarse sobre una no pasa dos semanas. */
const stepKey = (direction: -1 | 1, id: string) => `step:${direction}:${id}`

/** El destino de una clave; `null` si es «ninguno» o una flecha. */
function parseKey(key: string): ScheduleDropTarget | null {
  if (!key || key === NONE || key.startsWith("step:")) return null
  try {
    return JSON.parse(key) as ScheduleDropTarget
  } catch {
    return null
  }
}

/**
 * Lo que dice el destino no cambia nada de donde está. Lo que `from` no dice de la franja o del
 * recurso es «ninguno»: soltar algo sin repartidor en «Sin repartidor» no es moverlo.
 */
function sameAsFrom(target: ScheduleDropTarget, from: ScheduleDropTarget | undefined): boolean {
  if (!from) return false
  return (
    (target.date === undefined || target.date === from.date) &&
    (target.slot === undefined || target.slot === (from.slot ?? null)) &&
    (target.resourceId === undefined || target.resourceId === (from.resourceId ?? null))
  )
}

/** Los destinos que el teclado recorre, en el orden de la pantalla: sin las flechas ni lo oculto. */
function keyboardTargets(): HTMLElement[] {
  const seen = new Set<string>()
  return [...document.querySelectorAll<HTMLElement>("[data-drop-target]")].filter((element) => {
    const key = element.dataset.dropTarget ?? ""
    if (!parseKey(key) || seen.has(key)) return false
    if (element.closest("[inert]") || element.getClientRects().length === 0) return false
    seen.add(key)
    return true
  })
}

/** Lo que cambia durante un arrastre: qué se levanta, qué se está por levantar y qué hay debajo. */
interface DropSnapshot {
  draggingId: string | null
  liftingId: string | null
  overKey: string | null
  /** Nada se arrastra: las tarjetas se vuelven a pintar sin sus props al cambiar. */
  disabled: boolean
}

const IDLE: DropSnapshot = { draggingId: null, liftingId: null, overKey: null, disabled: false }

function createDropStore() {
  let snapshot = IDLE
  const listeners = new Set<() => void>()
  return {
    get: () => snapshot,
    set(patch: Partial<DropSnapshot>) {
      const next = { ...snapshot, ...patch }
      if (
        next.draggingId === snapshot.draggingId &&
        next.liftingId === snapshot.liftingId &&
        next.overKey === snapshot.overKey &&
        next.disabled === snapshot.disabled
      )
        return
      snapshot = next
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

interface DropContextValue {
  store: ReturnType<typeof createDropStore>
  getProps: (item: ScheduleDraggableItem) => ScheduleDraggableProps
}

const DropContext = React.createContext<DropContextValue | null>(null)

/** Una parte del almacén, con lo que la pide volviéndose a pintar solo cuando cambia. */
function useDropState<T>(context: DropContextValue | null, select: (snapshot: DropSnapshot) => T): T {
  return React.useSyncExternalStore(
    context?.store.subscribe ?? noSubscribe,
    () => select(context?.store.get() ?? IDLE),
    () => select(IDLE),
  )
}
const noSubscribe = () => () => {}

export function ScheduleDropProvider({
  children,
  onDrop,
  describe,
  hint = DEFAULT_HINT,
  disabled = false,
  scrollContainer = pageScroll,
}: ScheduleDropProviderProps) {
  const callbacks = React.useRef({ onDrop, describe })
  callbacks.current = { onDrop, describe }
  const [store] = React.useState(createDropStore)

  const geometry = React.useMemo<DragGeometry<string, ScheduleDraggableItem>>(
    () => ({
      targetFromPoint(_entry, point) {
        const element = document
          .elementFromPoint(point.x, point.y)
          ?.closest<HTMLElement>("[data-drop-target]")
        return element?.dataset.dropTarget ?? NONE
      },
      initialTarget: () => NONE,
      keyboardTarget(_entry, current, key) {
        const forward = key === "ArrowRight" || key === "ArrowDown"
        if (!forward && key !== "ArrowLeft" && key !== "ArrowUp") return null
        const targets = keyboardTargets()
        if (targets.length === 0) return null
        const at = targets.findIndex((element) => element.dataset.dropTarget === current)
        const next =
          at < 0
            ? forward
              ? 0
              : targets.length - 1
            : Math.min(Math.max(at + (forward ? 1 : -1), 0), targets.length - 1)
        const element = targets[next]
        element?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
        return element?.dataset.dropTarget ?? null
      },
      sameTarget: (a, b) => a === b,
      describe(_entry, key) {
        const target = parseKey(key)
        return target ? `Sobre ${callbacks.current.describe(target)}` : ""
      },
      // Una flecha, o donde ya estaba, no es un destino: el núcleo lo dice como «no se movió».
      onMove(entry, key) {
        const target = parseKey(key)
        if (!target || sameAsFrom(target, entry.from)) return false
        callbacks.current.onDrop(entry.id, target)
      },
    }),
    [],
  )

  const drag = useEntryDrag<string, ScheduleDraggableItem>(geometry, {
    enabled: !disabled,
    scrollContainer,
    messages: {
      lift: (entry) => `Moviendo ${entry.title}. ${hint} Escape cancela.`,
      keyboardLift: (entry) =>
        `Moviendo ${entry.title}. Flechas para elegir dónde, Intro para soltar, Escape para cancelar.`,
      moved: (entry, key) => `Soltaste ${entry.title} en ${callbacks.current.describe(parseKey(key) ?? {})}.`,
      unchanged: NOTHING_MOVED,
      cancelled: NOTHING_MOVED,
    },
  })

  // Qué se levanta y qué hay debajo, para quien lo pinta.
  const session = drag.session
  const draggingId = session?.entryId ?? null
  const overKey = session?.target ?? null
  React.useEffect(() => {
    store.set(draggingId ? { draggingId, overKey, liftingId: null } : { draggingId: null, overKey: null })
  }, [store, draggingId, overKey])
  React.useEffect(() => store.set({ disabled }), [store, disabled])


  // Lo que se tomó con el puntero: de dónde parte el fantasma y qué se dibuja. Y con qué se tocó
  // por última vez (el menú del navegador solo se calla para el dedo).
  const grab = React.useRef<{ item: ScheduleDraggableItem; x: number; y: number } | null>(null)
  const lastPointer = React.useRef("mouse")
  const liftingId = React.useSyncExternalStore(store.subscribe, () => store.get().liftingId, () => null)

  // Mientras se mantiene el dedo (antes de levantar), la tarjeta se achica un punto: dice que
  // algo va a pasar. Soltar o moverse más de lo que tolera el núcleo lo deshace.
  React.useEffect(() => {
    if (!liftingId) return
    const stop = () => store.set({ liftingId: null })
    const move = (event: PointerEvent) => {
      const start = grab.current
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > TOUCH_CANCEL_PX) stop()
    }
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
    window.addEventListener("pointermove", move)
    return () => {
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
      window.removeEventListener("pointermove", move)
    }
  }, [liftingId, store])

  // Las props de cada tarjeta son estables: leen el núcleo de ahora por la referencia.
  const live = React.useRef({ drag, disabled })
  live.current = { drag, disabled }
  const getProps = React.useCallback((item: ScheduleDraggableItem): ScheduleDraggableProps => {
    if (live.current.disabled || item.disabled) return {}
    const dragging = () => store.get().draggingId === item.id
    return {
      onPointerDown: (event) => {
        lastPointer.current = event.pointerType
        if (event.button !== 0) return
        grab.current = { item, x: event.clientX, y: event.clientY }
        // Solo el dedo espera los 400 ms (el lápiz arrastra como el mouse).
        if (event.pointerType === "touch") store.set({ liftingId: item.id })
        live.current.drag.getBlockProps(item).onPointerDown(event)
      },
      onKeyDown: (event) => {
        // Con la tarjeta levantada, Espacio no la abre: se suelta con Intro.
        if (dragging() && event.key === " ") event.preventDefault()
        live.current.drag.getBlockProps(item).onKeyDown(event)
      },
      // Levantada con el teclado, si el foco se va de la tarjeta queda donde estaba.
      onBlur: (event) => {
        if (!dragging() || event.currentTarget.contains(event.relatedTarget as Node | null)) return
        live.current.drag.cancel()
      },
      // Tras arrastrar (o mientras), el «clic» no abre la tarjeta.
      onClickCapture: (event) => {
        if (!live.current.drag.suppressClick() && !dragging()) return
        event.preventDefault()
        event.stopPropagation()
      },
      // Mantener el dedo no abre el menú del navegador; con el mouse, el clic derecho sigue igual.
      onContextMenu: (event) => {
        if (lastPointer.current === "touch") event.preventDefault()
      },
    }
  }, [store])

  const value = React.useMemo<DropContextValue>(() => ({ store, getProps }), [store, getProps])

  // Con el puntero, Escape también deja todo como estaba (con el teclado ya lo hace el núcleo).
  const pointerDrag = session != null && !session.keyboard
  React.useEffect(() => {
    if (!pointerDrag) return
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      live.current.drag.cancel()
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [pointerDrag])

  // El fantasma se arma una vez por arrastre y sigue al dedo con `transform` (sin recalcular la página).
  const held = draggingId && grab.current?.item.id === draggingId ? grab.current : null
  const ghost = React.useMemo(
    () => (held ? (held.item.ghost?.() ?? <span className="font-semibold">{held.item.title}</span>) : null),
    [held],
  )
  const delta = drag.ghostDelta
  const at = held && delta && pointerDrag ? { x: held.x + delta.x, y: held.y + delta.y } : null

  return (
    <DropContext.Provider value={value}>
      {children}
      {at && ghost ? (
        <div
          aria-hidden
          data-drop-ghost=""
          className="pointer-events-none fixed top-0 left-0 z-[60] w-[min(280px,72vw)] rounded-xl border-2 border-primary bg-card p-2 text-sm shadow-2xl motion-reduce:[--drop-ghost-tilt:0deg]"
          // Junto al dedo y sin tapar el destino: debajo si el dedo está arriba (la tira de días),
          // encima si está abajo. Inclinada un poco, salvo con menos movimiento.
          style={{
            transform: `translate3d(${Math.min(Math.max(at.x - 140, 8), window.innerWidth - 288)}px, ${
              at.y < 260 ? at.y + 44 : at.y - 110
            }px, 0) rotate(var(--drop-ghost-tilt, -2deg))`,
          }}
        >
          {ghost}
        </div>
      ) : null}
      <DragLiveRegion text={drag.announcement} />
    </DropContext.Provider>
  )
}

/**
 * Lo que se puede mantener y arrastrar: sus props van en el elemento que lo
 * contiene (`TaskCard` las acepta tal cual). Fuera de un
 * `ScheduleDropProvider` no hace nada.
 */
export function useScheduleDraggable(item: ScheduleDraggableItem): ScheduleDraggableProps {
  const context = React.useContext(DropContext)
  const dragging = useDropState(context, (snapshot) => snapshot.draggingId === item.id)
  const lifting = useDropState(context, (snapshot) => snapshot.liftingId === item.id)
  // Se lee para volver a pintarse cuando cambia (una lista memorizada no lo haría sola).
  const off = useDropState(context, (snapshot) => snapshot.disabled)
  if (!context || off) return {}
  return {
    ...context.getProps(item),
    "data-dragging": dragging ? "true" : undefined,
    "data-lifting": lifting ? "true" : undefined,
  }
}

/**
 * Un destino: sus props van en el elemento que recibe (un día, una franja, la
 * columna de un repartidor). `active` dice que hay algo levantado (para
 * marcar los destinos) y `over`, que está encima de este. Fuera de un
 * `ScheduleDropProvider` no hace nada.
 */
export function useScheduleDropTarget(target: ScheduleDropTarget | null): {
  props: { "data-drop-target"?: string; "data-drop-over"?: "true" }
  active: boolean
  over: boolean
} {
  return useDropKey(target ? dropKey(target) : null)
}

function useDropKey(key: string | null) {
  const context = React.useContext(DropContext)
  const active = useDropState(context, (snapshot) => snapshot.draggingId !== null)
  const over = useDropState(context, (snapshot) => key !== null && snapshot.overKey === key)
  if (!context || key === null) return { props: {}, active: false, over: false }
  return {
    props: { "data-drop-target": key, "data-drop-over": over ? ("true" as const) : undefined },
    active,
    over,
  }
}

export interface ScheduleStepArrowProps {
  direction: -1 | 1
  /** «Semana anterior», «Semana siguiente». */
  label: string
  onStep: () => void
  /**
   * `touch` (predeterminado): 44 px, redonda. `compact`: la angosta de la
   * franja de días de la agenda.
   */
  size?: "touch" | "compact"
  disabled?: boolean
  className?: string
}

/**
 * La flecha de la semana: la vía a la vista de lo que hace deslizar. Con algo
 * levantado, quedarse encima pasa de semana (otra vez, saliendo y volviendo),
 * para soltar en un día que no se veía.
 */
export function ScheduleStepArrow({
  direction,
  label,
  onStep,
  size = "touch",
  disabled = false,
  className,
}: ScheduleStepArrowProps) {
  const id = React.useId()
  const { props, over } = useDropKey(disabled ? null : stepKey(direction, id))
  const step = React.useRef(onStep)
  step.current = onStep
  React.useEffect(() => {
    if (!over) return
    const timer = window.setTimeout(() => step.current(), STEP_WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [over])
  const Icon = direction < 0 ? ChevronLeft : ChevronRight
  if (size === "touch")
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={label}
        disabled={disabled}
        onClick={onStep}
        {...props}
        className={cn("size-11 rounded-full text-muted-foreground", over && "bg-primary-soft text-foreground", className)}
      >
        <Icon aria-hidden className="size-5" />
      </Button>
    )
  // La angosta de la agenda, tal como era.
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onStep}
      {...props}
      className={cn(
        "flex h-[50px] w-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
        over && "bg-primary-soft text-foreground",
        className,
      )}
    >
      <Icon aria-hidden className="size-[18px]" />
    </button>
  )
}
