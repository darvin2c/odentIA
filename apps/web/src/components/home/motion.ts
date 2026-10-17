// Movimiento del inicio: la pausa de la portada vale para todas las escenas de la página,
// y quien pide menos movimiento ve directamente el estado final, sin animación.
import { useEffect, useRef, useState, useSyncExternalStore } from "react"

let paused = false
const subs = new Set<() => void>()

export const pauseStore = {
  get: () => paused,
  set(v: boolean) {
    paused = v
    subs.forEach((f) => {
      f()
    })
  },
  subscribe(f: () => void) {
    subs.add(f)
    return () => {
      subs.delete(f)
    }
  },
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

/** true si la persona pidió menos movimiento en su sistema. En el servidor, false. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    const on = () => setReduced(mq.matches)
    on()
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  return reduced
}

export function usePaused(): boolean {
  return useSyncExternalStore(pauseStore.subscribe, pauseStore.get, () => false)
}

/** Si las escenas se mueven: ni en pausa ni con menos movimiento. */
export function useMoving(): boolean {
  const reduced = useReducedMotion()
  const isPaused = usePaused()
  return !reduced && !isPaused
}

/** Ancho de teléfono (≤ 720 px). En el servidor, false. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia("(max-width: 720px)")
    const on = () => setNarrow(mq.matches)
    on()
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  return narrow
}

/** Intervalo que se limpia solo; la función siempre ve el último estado. */
export function useInterval(fn: () => void, ms: number) {
  const ref = useRefLatest(fn)
  // biome-ignore lint/correctness/useExhaustiveDependencies: ref es una referencia estable; se lee .current en cada tic a propósito.
  useEffect(() => {
    const id = setInterval(() => ref.current(), ms)
    return () => clearInterval(id)
  }, [ms])
}

function useRefLatest<T>(v: T) {
  const r = useRef(v)
  r.current = v
  return r
}
