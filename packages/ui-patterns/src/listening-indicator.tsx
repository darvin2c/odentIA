import { cn } from "@odentia/ui"
import { useEffect, useState, type ComponentProps } from "react"

export type ListeningState = "listening" | "paused"

interface ListeningIndicatorProps extends Omit<ComponentProps<"span">, "children"> {
  /** listening: barras con el nivel real; paused: corchetes y puntos quietos, en gris. */
  state: ListeningState
  /** Nivel real 0..1 del micrófono; solo mueve las barras con state="listening". */
  level?: number
  /** md: 40 px, el de la barra del dictado; sm: 20 px, dentro de un botón (Bandeja). */
  size?: "sm" | "md"
  /** brand: turquesa (gris en pausa); inherit: el color del texto que lo rodea (dentro de un botón lleno). */
  color?: "brand" | "inherit"
  /**
   * Anuncia el estado con aria-live («Escuchando»/«En pausa»), nunca los
   * niveles. En false el indicador es decorativo: quien lo usa nombra el
   * estado por su cuenta (p. ej. el aria-label del botón que lo contiene).
   */
  announce?: boolean
  listeningLabel?: string
  pausedLabel?: string
}

/**
 * Cuánto sube cada barra con el mismo nivel: la del centro más, las de los
 * bordes menos. Hay un solo nivel real (el `AnalyserNode` no separa
 * frecuencias aquí); el perfil solo le da forma de onda.
 */
const PROFILE = [0.55, 0.85, 1, 0.75, 0.6] as const

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
 * Que se note que odentIA escucha (lienzo del dictado, opción A): la onda
 * entre los corchetes de la marca Odentia[32]. Cinco barras siguen el volumen
 * real de la voz; en silencio quedan planas; en pausa, corchetes y puntos en
 * gris. Con movimiento reducido, un punto fijo entre los corchetes.
 */
function ListeningIndicator({
  state,
  level = 0,
  size = "md",
  color = "brand",
  announce = true,
  listeningLabel = "Escuchando",
  pausedLabel = "En pausa",
  className,
  ...props
}: ListeningIndicatorProps) {
  const reducedMotion = usePrefersReducedMotion()
  const listening = state === "listening"
  const status = listening ? listeningLabel : pausedLabel
  const value = Math.min(1, Math.max(0, level))
  const sm = size === "sm"
  // Alto de las barras en px: un piso visible (silencio) y el resto según la voz.
  const floor = sm ? 3 : 5
  const span = sm ? 11 : 21
  return (
    <span
      {...(announce ? { role: "status", "aria-label": status } : { "aria-hidden": true })}
      data-state={state}
      className={cn(
        "inline-flex shrink-0 items-center",
        sm ? "h-5 gap-0.5" : "h-10 gap-1",
        color === "inherit" ? undefined : listening ? "text-primary" : "text-muted-foreground",
        className,
      )}
      {...props}
    >
      {/* El ancho del borde va antes del lado en cero: así uno no pisa al otro. */}
      <span aria-hidden="true" className={cn(sm ? "h-4 w-1 border-2" : "h-[34px] w-2 border-[2.5px]", "border-r-0 border-current")} />
      <span aria-hidden="true" className={cn("inline-flex items-center justify-center", sm ? "h-4 w-[23px] gap-0.5" : "h-[30px] w-[39px] gap-[3px]")}>
        {listening && reducedMotion ? (
          <span className={cn("rounded-full bg-current", sm ? "size-1.5" : "size-2")} />
        ) : (
          PROFILE.map((weight, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: barras fijas, sin reordenar.
              key={index}
              className={cn("rounded-full bg-current transition-[height] duration-150 motion-reduce:transition-none", sm ? "w-[3px]" : "w-1")}
              style={{ height: `${listening ? Math.round(floor + value * weight * span) : floor - 1}px` }}
            />
          ))
        )}
      </span>
      <span aria-hidden="true" className={cn(sm ? "h-4 w-1 border-2" : "h-[34px] w-2 border-[2.5px]", "border-l-0 border-current")} />
      {announce ? <span className="sr-only">{status}</span> : null}
    </span>
  )
}

export { ListeningIndicator }
export type { ListeningIndicatorProps }
