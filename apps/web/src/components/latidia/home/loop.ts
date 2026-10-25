// El movimiento de las réplicas de latidIA (lienzo «Inicio»): cada escena avanza un paso cada `ms`,
// se queda quieta `hold` pasos en el último y vuelve a empezar. En el servidor y con movimiento
// reducido se ve el estado final, sin animación: la página se lee entera aunque nada se mueva.
import { useEffect, useState } from "react"

/** true si la persona pidió menos movimiento en su sistema. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

interface LoopOptions {
  /** Pasos de la escena; el último es el estado final. */
  len: number
  /** Pasos que se queda en el final antes de volver a empezar. */
  hold: number
  ms: number
  /** En pausa no avanza (el botón «Pausar» de la portada). */
  paused?: boolean
}

/**
 * El paso en que va la escena (de 0 a `len - 1`) y cómo reiniciarla. Devuelve
 * el final hasta que se monta en el navegador, y siempre con movimiento reducido.
 */
export function useLoop({ len, hold, ms, paused = false }: LoopOptions): { step: number; restart: () => void; moving: boolean } {
  const [tick, setTick] = useState(len - 1)
  const [moving, setMoving] = useState(false)

  useEffect(() => {
    if (prefersReducedMotion()) return
    setMoving(true)
    setTick(0)
  }, [])

  useEffect(() => {
    if (!moving || paused) return
    const id = setInterval(() => setTick((t) => (t + 1) % (len + hold)), ms)
    return () => clearInterval(id)
  }, [moving, paused, len, hold, ms])

  // «Repetir» lo pide quien mira: se mueve aunque prefiera menos movimiento.
  const restart = () => {
    setTick(0)
    setMoving(true)
  }
  return { step: Math.min(tick, len - 1), restart, moving }
}
