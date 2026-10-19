import { cn } from "@odentia/ui"
import { Mic } from "lucide-react"
import { useEffect, useState, type ComponentProps } from "react"

export type ListeningState = "listening" | "paused"

interface ListeningIndicatorProps extends Omit<ComponentProps<"span">, "children"> {
  /** listening: barras con el nivel real; paused: corchetes quietos y atenuados. */
  state: ListeningState
  /** Nivel real 0..1 del micrófono; solo anima con state="listening". */
  level?: number
  size?: "sm" | "md"
  /**
   * Anuncia el estado con aria-live («Escuchando»/«En pausa»), nunca los
   * niveles. En false el indicador es decorativo: quien lo usa nombra el
   * estado por su cuenta (p. ej. el aria-label del botón que lo contiene).
   */
  announce?: boolean
  listeningLabel?: string
  pausedLabel?: string
}

const BAR_COUNT = 4

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    setReduced(query.matches)
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  return reduced
}

/**
 * Que se note que odentIA escucha, con los corchetes de la marca (los del
 * Spinner): el micrófono entre corchetes y unas barras que se mueven con el
 * volumen real de la voz. En silencio queda quieto; en pausa, atenuado.
 * Con movimiento reducido, un punto fijo en vez de barras.
 */
function ListeningIndicator({
  state,
  level = 0,
  size = "md",
  announce = true,
  listeningLabel = "Escuchando",
  pausedLabel = "En pausa",
  className,
  ...props
}: ListeningIndicatorProps) {
  const reducedMotion = usePrefersReducedMotion()
  const listening = state === "listening"
  const status = listening ? listeningLabel : pausedLabel
  const bars = listening && !reducedMotion
  const dot = listening && reducedMotion
  return (
    <span
      role={announce ? "status" : undefined}
      aria-label={announce ? status : undefined}
      aria-hidden={announce ? undefined : true}
      className={cn("inline-flex items-center gap-1", listening ? undefined : "opacity-60", className)}
      {...props}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 10 28"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        className={size === "sm" ? "h-5 w-2" : "h-7 w-2.5"}
      >
        <path d="M9 1H2V27H9" />
      </svg>
      <span className="inline-flex flex-col items-center gap-0.5" aria-hidden="true">
        <Mic className={size === "sm" ? "size-3.5" : "size-4"} />
        {bars ? (
          <span className="flex h-3 items-end gap-px">
            {Array.from({ length: BAR_COUNT }, (_, index) => (
              <span
                key={index}
                className="w-1 rounded-full bg-current transition-[height] duration-150 motion-reduce:hidden"
                // Todas las barras marcan el mismo nivel real: es un vúmetro,
                // no un espectro (el AnalyserNode no separa frecuencias aquí).
                style={{ height: `${24 + Math.min(1, Math.max(0, level)) * 76}%` }}
              />
            ))}
          </span>
        ) : null}
        {dot ? <span className="size-1.5 rounded-full bg-current" /> : null}
      </span>
      <svg
        aria-hidden="true"
        viewBox="0 0 10 28"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        className={size === "sm" ? "h-5 w-2" : "h-7 w-2.5"}
      >
        <path d="M1 27H8V1H1" />
      </svg>
      {announce ? <span className="sr-only">{status}</span> : null}
    </span>
  )
}

export { ListeningIndicator }
export type { ListeningIndicatorProps }
