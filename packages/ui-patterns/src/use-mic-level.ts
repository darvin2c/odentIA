import { useEffect, useRef, useState } from "react"

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext
  }
}

export type MicStreamState = "idle" | "active" | "denied" | "unavailable"

interface UseMicLevelOptions {
  /**
   * Flujo ya abierto (p. ej. el de un MediaRecorder en curso): se reutiliza
   * para medir y nunca se pide otro micrófono ni se paran sus pistas.
   */
  stream?: MediaStream | null
  /** Solo mide (y, si se pide, adquiere) mientras es true; en false libera lo adquirido. */
  active: boolean
  /**
   * Sin flujo propio y con active: pedir un getUserMedia solo para medir el
   * nivel. Defecto false: sin flujo no se toca el micrófono.
   * Necesario con SpeechRecognition, que no expone su flujo: la medición va
   * en un flujo paralelo de solo-nivel, no en el del reconocimiento.
   */
  acquire?: boolean
}

export interface MicLevel {
  /** Nivel real 0..1, suavizado y cuantizado para no repintar a 60 fps. 0 sin medición. */
  level: number
  /**
   * idle: apagado o midiendo aún sin confirmar; active: midiendo con contexto
   * reanudado; denied: sin permiso; unavailable: sin micrófono o sin audio.
   */
  streamState: MicStreamState
}

/**
 * Nivel real del micrófono con AnalyserNode. Un solo camino de medición
 * (setup/tick/liberación) con adquisición opcional: reutiliza el flujo dado
 * y solo cierra el que adquiere. `active` llega solo tras reanudar el
 * contexto con éxito; cualquier fallo libera de inmediato y reporta
 * `unavailable`, nunca un nivel fingido.
 */
export function useMicLevel({ stream, active, acquire = false }: UseMicLevelOptions): MicLevel {
  const [level, setLevel] = useState(0)
  const [streamState, setStreamState] = useState<MicStreamState>("idle")
  const levelRef = useRef(0)

  useEffect(() => {
    levelRef.current = 0
    setLevel(0)
    setStreamState("idle")
    if (!active || typeof window === "undefined") {
      setStreamState("idle")
      return undefined
    }
    const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext ?? null
    if (!AudioContextCtor) {
      setStreamState("unavailable")
      return undefined
    }
    if (!stream && !(acquire && navigator.mediaDevices?.getUserMedia)) {
      setStreamState(acquire ? "unavailable" : "idle")
      return undefined
    }
    let cancelled = false
    let raf = 0
    let context: AudioContext | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let analyser: AnalyserNode | null = null
    /** Flujo adquirido aquí: el único cuyas pistas se paran al liberar. */
    let owned: MediaStream | null = null
    const endListeners: Array<{ track: MediaStreamTrack; onEnded: () => void }> = []

    const releaseAudio = () => {
      window.cancelAnimationFrame(raf)
      for (const { track, onEnded } of endListeners) track.removeEventListener("ended", onEnded)
      endListeners.length = 0
      source?.disconnect()
      source = null
      analyser = null
      if (context) {
        void context.close().catch(() => undefined)
        context = null
      }
    }
    const releaseAll = () => {
      releaseAudio()
      if (owned) {
        for (const track of owned.getTracks()) track.stop()
        owned = null
      }
      levelRef.current = 0
      setLevel(0)
    }
    const fail = () => {
      releaseAll()
      if (!cancelled) setStreamState("unavailable")
    }
    const onTrackEnded = () => {
      // Una pista que termina apaga la medición; las pistas ajenas no se paran.
      releaseAll()
      if (!cancelled) setStreamState("unavailable")
    }
    const loop = (data: Uint8Array<ArrayBuffer>) => {
      if (cancelled || !analyser) return
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (const value of data) {
        const sample = (value - 128) / 128
        sum += sample * sample
      }
      // La voz típica queda a media escala y el silencio en 0.
      const target = Math.min(1, Math.max(0, Math.sqrt(sum / data.length) * 6))
      // Ataque rápido, caída lenta: la voz se nota al momento y no parpadea.
      const next = levelRef.current + (target - levelRef.current) * (target > levelRef.current ? 0.6 : 0.2)
      levelRef.current = next
      // Cuantizado: solo repinta cuando el nivel visible cambia de verdad.
      const visible = Math.round(next * 20) / 20
      if (visible !== shown) {
        shown = visible
        setLevel(visible)
      }
      raf = window.requestAnimationFrame(() => loop(data))
    }
    let shown = 0
    const attach = (target: MediaStream) => {
      try {
        context = new AudioContextCtor()
        analyser = context.createAnalyser()
        analyser.fftSize = 512
        source = context.createMediaStreamSource(target)
        source.connect(analyser)
      } catch {
        fail()
        return
      }
      for (const track of target.getAudioTracks()) {
        const onEnded = onTrackEnded
        track.addEventListener("ended", onEnded)
        endListeners.push({ track, onEnded })
      }
      context
        .resume()
        .then(() => {
          if (cancelled || !context || !analyser) {
            releaseAll()
            return
          }
          setStreamState("active")
          raf = window.requestAnimationFrame(() => loop(new Uint8Array(512)))
        })
        .catch(() => fail())
    }

    if (stream) {
      attach(stream)
    } else {
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((acquired) => {
          if (cancelled) {
            for (const track of acquired.getTracks()) track.stop()
            return
          }
          owned = acquired
          attach(acquired)
        })
        .catch((error: unknown) => {
          if (cancelled) return
          setStreamState(error instanceof DOMException && error.name === "NotAllowedError" ? "denied" : "unavailable")
        })
    }
    return () => {
      cancelled = true
      releaseAll()
    }
  }, [stream, active, acquire])

  return { level, streamState }
}
