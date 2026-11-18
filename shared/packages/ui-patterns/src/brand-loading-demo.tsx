import { useCallback, useEffect, useRef, useState } from "react"

export interface DemoSettings { fail: boolean; slow: boolean }
export interface DemoReadOptions { debounce?: number; fail?: boolean }

/**
 * Transporte simulado solo para Storybook: temporizadores locales sin efectos
 * externos. El indicador visual es el Spinner real de producción (@odentia/ui);
 * lo simulado aquí es el transporte (demora/errores), nunca el dibujo.
 */
export function useDemoRequest(settings: DemoSettings) {
  const latest = useRef(settings)
  latest.current = settings
  const timer = useRef<number | undefined>(undefined)
  const running = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => () => { window.clearTimeout(timer.current); running.current = false }, [])
  const run = useCallback((onSuccess: () => void, failureMessage: string) => {
    if (running.current) return false
    running.current = true
    setBusy(true)
    setError(null)
    const outcome = latest.current
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      running.current = false
      setBusy(false)
      if (outcome.fail) setError(failureMessage)
      else onSuccess()
    }, outcome.slow ? 5000 : 1600)
    return true
  }, [])
  const clearError = useCallback(() => { if (!running.current) setError(null) }, [])
  return { busy, error, run, clearError }
}

/** Lectura reemplazable: escribir o cambiar de contexto invalida cualquier respuesta anterior. */
export function useDemoRead(settings: DemoSettings) {
  const latest = useRef(settings)
  latest.current = settings
  const timer = useRef<number | undefined>(undefined)
  const revision = useRef(0)
  const [phase, setPhase] = useState<"idle" | "debounce" | "loading">("idle")
  const [error, setError] = useState<string | null>(null)
  useEffect(() => () => { window.clearTimeout(timer.current); revision.current += 1 }, [])
  const cancel = useCallback(() => {
    window.clearTimeout(timer.current)
    revision.current += 1
    setPhase("idle")
    setError(null)
  }, [])
  const run = useCallback((onSuccess: () => void, failureMessage: string, options: DemoReadOptions = {}) => {
    window.clearTimeout(timer.current)
    const current = ++revision.current
    const outcome = latest.current
    const debounce = options.debounce ?? 0
    const fail = options.fail ?? outcome.fail
    setError(null)
    const fetchResult = () => {
      if (current !== revision.current) return
      setPhase("loading")
      timer.current = window.setTimeout(() => {
        if (current !== revision.current) return
        setPhase("idle")
        if (fail) setError(failureMessage)
        else onSuccess()
      }, outcome.slow ? 5000 : 1600)
    }
    if (debounce > 0) {
      setPhase("debounce")
      timer.current = window.setTimeout(fetchResult, debounce)
    } else fetchResult()
  }, [])
  return { phase, busy: phase !== "idle", error, run, cancel }
}
