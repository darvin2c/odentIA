// El movimiento de las réplicas de latidIA (lienzo «Inicio»): cada escena avanza un paso cada `ms`,
// se queda quieta `hold` pasos en el último y vuelve a empezar, `rounds` veces; después se queda
// terminada (WCAG 2.2.2: lo que se mueve solo no se mueve sin fin). «Volver a ver» la empieza otra vez.
// En el servidor y con movimiento reducido se ve el estado final, sin animación: la página se lee
// entera aunque nada se mueva.
import { useEffect, useRef, useState } from "react"

/** true si la persona pidió menos movimiento en su sistema. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** Vueltas que da sola una escena antes de quedarse terminada. */
export const ROUNDS = 2

interface LoopOptions {
  /** Pasos de la escena; el último es el estado final. */
  len: number
  /** Pasos que se queda en el final antes de volver a empezar. */
  hold: number
  ms: number
  /** En pausa no avanza (el botón «Pausar» de la escena). */
  paused?: boolean
  /** Vueltas antes de quedarse terminada. */
  rounds?: number
}

/**
 * El paso en que va la escena (de 0 a `len - 1`), cómo reiniciarla y si ya terminó sus vueltas
 * (`done`: quieta en el final). Devuelve el final hasta que se monta en el navegador, y siempre con
 * movimiento reducido.
 */
export function useLoop({ len, hold, ms, paused = false, rounds = ROUNDS }: LoopOptions): {
  step: number
  restart: () => void
  moving: boolean
  done: boolean
} {
  const [tick, setTick] = useState(len - 1)
  const [moving, setMoving] = useState(false)
  const [done, setDone] = useState(false)
  const laps = useRef(0)
  const at = useRef(tick)
  at.current = tick

  useEffect(() => {
    if (prefersReducedMotion()) return
    setMoving(true)
    setTick(0)
  }, [])

  useEffect(() => {
    if (!moving || paused || done) return
    const id = setInterval(() => {
      const next = at.current + 1
      if (next < len + hold) {
        setTick(next)
        return
      }
      // Terminó una vuelta: vuelve a empezar o, si ya dio las suyas, se queda en el final.
      laps.current += 1
      if (laps.current >= rounds) {
        setTick(len - 1)
        setDone(true)
      } else setTick(0)
    }, ms)
    return () => clearInterval(id)
  }, [moving, paused, done, len, hold, ms, rounds])

  // «Volver a ver» lo pide quien mira: se mueve aunque prefiera menos movimiento, una vuelta.
  const restart = () => {
    laps.current = rounds - 1
    setDone(false)
    setTick(0)
    setMoving(true)
  }
  return { step: Math.min(tick, len - 1), restart, moving, done }
}
