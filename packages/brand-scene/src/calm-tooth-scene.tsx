import { useEffect, useRef } from "react"
import { DAY, type DayEvent } from "./hero-data.js"
import { type SceneHost, ToothScene } from "./tooth-scene.js"

export interface CalmToothSceneProps {
  className?: string
  /** Cada cuánto se enciende una pieza nueva, en milisegundos. */
  intervalMs?: number
  /** Trabajos ya hechos al abrir: la escena no empieza vacía. */
  startStep?: number
  /** Avisa cada trabajo nuevo, para contarlo al lado de la escena. */
  onWork?: (event: DayEvent) => void
}

/**
 * La escena de la portada de la web, en calma: las piezas giran despacio, se
 * inclinan con el cursor y cada pocos segundos una se enciende con el color
 * del agente que hizo el trabajo. Sin canales, mensajes que viajan ni
 * registro. Con «menos movimiento» queda quieta; sin WebGL no dibuja nada y
 * el fondo de quien la contiene queda solo.
 */
export function CalmToothScene({
  className,
  intervalMs = 3200,
  startStep = 6,
  onWork,
}: CalmToothSceneProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  const onWorkRef = useRef(onWork)
  onWorkRef.current = onWork

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    let step = Math.min(32, Math.max(0, startStep))
    const host: SceneHost = {
      state: () => ({ step, hover: -1, still }),
      anchor: () => [0, 0],
      panelPt: () => [0, 0],
      cap: null,
      lineIn: null,
      lineOut: null,
      dot: null,
    }
    const scene = new ToothScene(host)
    if (!scene.start(cv)) return
    const first = DAY.ev[step - 1]
    if (first) onWorkRef.current?.(first)
    const timer = still
      ? undefined
      : window.setInterval(() => {
          step = step >= 32 ? 1 : step + 1
          scene.stepAt = performance.now()
          const ev = DAY.ev[step - 1]
          if (ev) onWorkRef.current?.(ev)
        }, intervalMs)
    const move = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect()
      scene.tmx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1))
      scene.tmy = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1))
    }
    const leave = () => {
      scene.tmx = 0
      scene.tmy = 0
    }
    const area = cv.parentElement?.parentElement ?? cv
    area.addEventListener("pointermove", move)
    area.addEventListener("pointerleave", leave)
    return () => {
      if (timer) window.clearInterval(timer)
      area.removeEventListener("pointermove", move)
      area.removeEventListener("pointerleave", leave)
      scene.stop()
    }
  }, [intervalMs, startStep])

  return (
    <div className={className} aria-hidden="true">
      <canvas ref={ref} style={{ display: "block", width: "100%", height: "100%" }} />
    </div>
  )
}
