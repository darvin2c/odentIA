import { useEffect, useRef, useState } from "react"
import type { MicLevel } from "./use-mic-level.js"

/** Silencio con medición real tras el que se avisa que el micrófono no capta voz. */
export const SILENCE_NOTICE_MS = 8000
/** Nivel por encima del ruido de fondo: por debajo no cuenta como voz. */
export const AUDIBLE_LEVEL = 0.06

export interface ListeningStatus {
  /** Segundos desde que empezó a escuchar (0 si no escucha). */
  seconds: number
  /** Lleva más de ocho segundos sin voz con el micrófono midiendo de verdad. */
  silent: boolean
}

/**
 * El reloj y el «No te oigo» de todo lo que escucha (dictado, Bandeja): una
 * sola regla. El aviso lo decide un reloj que consulta la última medición,
 * no el nivel del render: con voz constante o silencio total no hay
 * repintados que renueven nada. Sin medición activa nunca se avisa.
 */
export function useListeningStatus(listening: boolean, metering: MicLevel): ListeningStatus {
  const [seconds, setSeconds] = useState(0)
  const [silent, setSilent] = useState(false)
  const lastAudible = useRef(0)
  const meteringRef = useRef(metering)
  meteringRef.current = metering
  useEffect(() => {
    setSeconds(0)
    setSilent(false)
    lastAudible.current = 0
    if (!listening) return undefined
    const started = Date.now()
    const timer = window.setInterval(() => {
      const now = Date.now()
      setSeconds(Math.floor((now - started) / 1000))
      const current = meteringRef.current
      if (current.streamState !== "active") {
        setSilent(false)
        return
      }
      if (lastAudible.current === 0) lastAudible.current = now
      if (current.level >= AUDIBLE_LEVEL) {
        lastAudible.current = now
        setSilent(false)
      } else {
        setSilent(now - lastAudible.current >= SILENCE_NOTICE_MS)
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [listening])
  return { seconds, silent }
}

/** «0:08», «1:24»: el reloj de lo que se está escuchando. */
export function listeningClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}
