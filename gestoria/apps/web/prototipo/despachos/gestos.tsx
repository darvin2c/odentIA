import { cn } from "@odentia/ui"
import { formatDateLong, formatDayShort } from "@odentia/ui-patterns"
import { ChevronLeft, ChevronRight } from "lucide-react"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

/**
 * La capa táctil del prototipo de Despachos, fina y propia: lo que la pieza común de agenda
 * (`shared/packages/ui-patterns/src/schedule`) todavía no trae. Va en un PR de shared aparte,
 * que también mejora la Agenda de odentIA:
 *
 * - `TiraDias`: `ScheduleDayStrip` con el número del día (no solo puntos), el sustantivo
 *   («entregas», no «citas»), el feriado, flechas de 44 px y cada día como destino al arrastrar.
 * - `ArrastreProvider` y `useArrastrable`: mantener 400 ms y mover con el dedo, o arrastrar con
 *   el mouse tras 4 px, como `useEntryDrag` de la agenda; pero el destino es un día, una franja o
 *   un repartidor (no un minuto), y al soltar no se mueve nada: se abre «Pasar a…» ya lleno.
 *   Deslizar de lado es `ScheduleSnapPager`, la pieza real.
 */

/* ---------- Tira de días ---------- */

export interface DiaCarga {
  count: number
  /** Algo que no se entregó ese día y vuelve. */
  alerta?: boolean
  feriado?: string
}

export function TiraDias({
  dates,
  value,
  onChange,
  today,
  load,
  noun = ["entrega", "entregas"],
  className,
}: {
  dates: string[]
  value: string
  onChange: (date: string) => void
  today?: string
  load?: (date: string) => DiaCarga | undefined
  noun?: [string, string]
  className?: string
}) {
  const { activo, sobre } = useArrastre()
  return (
    <div role="group" aria-label="Días de la semana" className={cn("flex gap-1", className)}>
      {dates.map((date) => {
        const chosen = date === value
        const [weekday = "", number = ""] = formatDayShort(date).split(" ")
        const d = load?.(date)
        const destino = sobre?.fecha === date && !sobre.franja && !sobre.rep
        return (
          <button
            key={date}
            type="button"
            data-destino={JSON.stringify({ fecha: date })}
            aria-label={`${formatDateLong(date).replace(/ de \d{4}$/, "")}${date === today ? ", hoy" : ""}${
              d?.feriado
                ? `, feriado: ${d.feriado}`
                : d
                  ? `, ${d.count === 0 ? `sin ${noun[1]}` : `${d.count} ${d.count === 1 ? noun[0] : noun[1]}`}${d.alerta ? ", algo no se entregó" : ""}`
                  : ""
            }`}
            aria-current={chosen ? "date" : undefined}
            onClick={() => onChange(date)}
            className={cn(
              "relative flex h-[62px] min-w-0 flex-1 basis-0 flex-col items-center justify-center rounded-xl border outline-none transition-[background-color,border-color,transform] duration-150 select-none",
              "focus-visible:ring-2 focus-visible:ring-ring",
              chosen
                ? "border-primary bg-primary text-primary-foreground"
                : date === today
                  ? "border-primary bg-card"
                  : "border-border bg-card hover:border-primary",
              d?.feriado && !chosen && "border-dashed bg-muted/60",
              activo && "border-dashed",
              destino && "scale-[1.06] border-2 border-primary bg-primary-soft text-foreground",
            )}
          >
            <span
              className={cn(
                "text-[11px] leading-[14px] font-semibold capitalize",
                !chosen && "text-muted-foreground",
              )}
            >
              {weekday.replace(".", "")}
            </span>
            <span className="text-[17px] leading-[20px] font-bold tabular-nums">{number}</span>
            <span
              aria-hidden
              className={cn(
                "mt-0.5 h-[15px] text-[11px] leading-[15px] font-semibold tabular-nums",
                chosen ? "text-primary-foreground/85" : "text-muted-foreground",
              )}
            >
              {d?.feriado ? "Feriado" : d && d.count > 0 ? d.count : "·"}
            </span>
            {d?.alerta ? (
              <span
                aria-hidden
                className={cn(
                  "absolute top-1 right-1 size-2 rounded-full",
                  chosen ? "bg-primary-foreground" : "bg-destructive",
                )}
              />
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

/** Flecha de 44 px para la semana: la vía visible del deslizar. Al arrastrar encima, pasa sola. */
export function Flecha({
  dir,
  onClick,
  label,
}: {
  dir: -1 | 1
  onClick: () => void
  label: string
}) {
  const { sobre } = useArrastre()
  const Icon = dir < 0 ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      data-destino={JSON.stringify({ semana: dir })}
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
        sobre?.semana === dir && "bg-primary-soft text-foreground",
      )}
    >
      <Icon aria-hidden className="size-5" />
    </button>
  )
}

/* ---------- Mantener y arrastrar ---------- */

export interface Destino {
  fecha?: string
  franja?: string | null
  rep?: string | null
  semana?: -1 | 1
}

interface Estado {
  id: string
  x: number
  y: number
  fantasma: ReactNode
}

interface Ctx {
  activo: Estado | null
  sobre: Destino | null
  empezar: (e: Estado) => void
}

const Arrastre = createContext<Ctx>({ activo: null, sobre: null, empezar: () => {} })
export const useArrastre = () => useContext(Arrastre)

const LARGO_MS = 400
const TOLERANCIA_TACTIL = 10
const UMBRAL_MOUSE = 4
/** Cuánto hay que quedarse sobre una flecha para que pase de semana. */
const ESPERA_SEMANA_MS = 650

function destinoEn(x: number, y: number): Destino | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-destino]")
  if (!el) return null
  try {
    return JSON.parse(el.dataset.destino ?? "") as Destino
  } catch {
    return null
  }
}

const mismo = (a: Destino | null, b: Destino | null) => JSON.stringify(a) === JSON.stringify(b)

export function ArrastreProvider({
  children,
  onSoltar,
  onSemana,
  describir,
}: {
  children: ReactNode
  onSoltar: (id: string, destino: Destino) => void
  onSemana: (dir: -1 | 1) => void
  /** Qué se anuncia al pasar sobre un destino: «viernes 28, tarde». */
  describir: (d: Destino) => string
}) {
  const [activo, setActivo] = useState<Estado | null>(null)
  const [sobre, setSobre] = useState<Destino | null>(null)
  const [voz, setVoz] = useState("")
  const ref = useRef<{ activo: Estado | null; sobre: Destino | null; semana?: number }>({
    activo: null,
    sobre: null,
  })
  const cb = useRef({ onSoltar, onSemana, describir })
  cb.current = { onSoltar, onSemana, describir }

  const empezar = useCallback((e: Estado) => {
    ref.current.activo = e
    setActivo(e)
    setVoz(
      "Moviendo la entrega. Suéltala sobre un día, una franja o un repartidor. Escape cancela.",
    )
    navigator.vibrate?.(12)
  }, [])

  useEffect(() => {
    if (!activo) return
    const mover = (x: number, y: number) => {
      const a = ref.current.activo
      if (!a) return
      ref.current.activo = { ...a, x, y }
      setActivo(ref.current.activo)
      const d = destinoEn(x, y)
      if (!mismo(d, ref.current.sobre)) {
        ref.current.sobre = d
        setSobre(d)
        window.clearTimeout(ref.current.semana)
        if (d?.semana) {
          const dir = d.semana
          ref.current.semana = window.setTimeout(() => cb.current.onSemana(dir), ESPERA_SEMANA_MS)
        } else if (d) setVoz(`Sobre ${cb.current.describir(d)}`)
      }
      // Cerca del borde de arriba o de abajo, la página se desplaza sola.
      const borde = 70
      if (y < borde) window.scrollBy(0, -12)
      else if (y > window.innerHeight - borde) window.scrollBy(0, 12)
    }
    const terminar = (soltar: boolean) => {
      const a = ref.current.activo
      const d = ref.current.sobre
      window.clearTimeout(ref.current.semana)
      ref.current = { activo: null, sobre: null }
      setActivo(null)
      setSobre(null)
      if (soltar && a && d && !d.semana) cb.current.onSoltar(a.id, d)
      else setVoz("No se movió nada.")
    }
    const pm = (e: PointerEvent) => mover(e.clientX, e.clientY)
    const tm = (e: TouchEvent) => {
      // Mientras se arrastra, el dedo no desplaza la página ni pasa de día.
      e.preventDefault()
      const t = e.touches[0]
      if (t) mover(t.clientX, t.clientY)
    }
    const up = () => terminar(true)
    const key = (e: KeyboardEvent) => e.key === "Escape" && terminar(false)
    window.addEventListener("pointermove", pm)
    window.addEventListener("touchmove", tm, { passive: false })
    window.addEventListener("pointerup", up)
    window.addEventListener("touchend", up)
    window.addEventListener("pointercancel", up)
    window.addEventListener("keydown", key)
    return () => {
      window.removeEventListener("pointermove", pm)
      window.removeEventListener("touchmove", tm)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("touchend", up)
      window.removeEventListener("pointercancel", up)
      window.removeEventListener("keydown", key)
    }
    // Se arma una vez por arrastre; lo demás vive en `ref`.
  }, [!!activo])

  const value = useMemo(() => ({ activo, sobre, empezar }), [activo, sobre, empezar])
  return (
    <Arrastre.Provider value={value}>
      {children}
      {activo ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[60] w-[min(280px,72vw)] rotate-[-2deg] rounded-xl border-2 border-primary bg-card p-2 shadow-2xl motion-safe:animate-in motion-safe:zoom-in-95"
          // Junto al dedo, sin tapar el destino: debajo si el dedo está arriba (la tira de días),
          // encima si está abajo.
          style={{
            left: Math.min(Math.max(activo.x - 140, 8), window.innerWidth - 288),
            top: activo.y < 260 ? activo.y + 44 : activo.y - 110,
          }}
        >
          {activo.fantasma}
        </div>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {voz}
      </p>
    </Arrastre.Provider>
  )
}

/**
 * Lo que se puede mantener y arrastrar. Un toque sigue siendo un toque (abre la entrega); el
 * desplazamiento normal no se toca hasta que se mantiene el dedo quieto 400 ms.
 */
export function useArrastrable(id: string, fantasma: () => ReactNode) {
  const { empezar, activo } = useArrastre()
  const t = useRef<{ x: number; y: number; timer?: number; tipo?: string; hecho?: boolean }>({
    x: 0,
    y: 0,
  })
  const [levantando, setLevantando] = useState(false)
  const cancelar = () => {
    window.clearTimeout(t.current.timer)
    setLevantando(false)
  }
  return {
    arrastrando: activo?.id === id,
    levantando,
    props: {
      "data-arrastrable": id,
      onPointerDown: (e: React.PointerEvent) => {
        if (e.button !== 0) return
        t.current = { x: e.clientX, y: e.clientY, tipo: e.pointerType, hecho: false }
        if (e.pointerType !== "mouse") {
          setLevantando(true)
          t.current.timer = window.setTimeout(() => {
            t.current.hecho = true
            setLevantando(false)
            empezar({ id, x: t.current.x, y: t.current.y, fantasma: fantasma() })
          }, LARGO_MS)
        }
      },
      onPointerMove: (e: React.PointerEvent) => {
        const dx = Math.abs(e.clientX - t.current.x)
        const dy = Math.abs(e.clientY - t.current.y)
        if (t.current.tipo === "mouse") {
          if (e.buttons === 1 && !t.current.hecho && (dx > UMBRAL_MOUSE || dy > UMBRAL_MOUSE)) {
            t.current.hecho = true
            empezar({ id, x: e.clientX, y: e.clientY, fantasma: fantasma() })
          }
        } else if (!t.current.hecho && (dx > TOLERANCIA_TACTIL || dy > TOLERANCIA_TACTIL))
          cancelar()
      },
      onPointerUp: cancelar,
      onPointerCancel: cancelar,
      onPointerLeave: () => t.current.tipo !== "mouse" && !t.current.hecho && cancelar(),
      // Tras arrastrar, el «clic» de soltar no abre la entrega.
      onClickCapture: (e: React.MouseEvent) => {
        if (t.current.hecho) {
          e.preventDefault()
          e.stopPropagation()
          t.current.hecho = false
        }
      },
      // Mantener el dedo no abre el menú del navegador.
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    },
  }
}
