import { useRouterState } from "@tanstack/react-router"
import { useEffect, useState } from "react"

/** Lo instantáneo no parpadea: la barra aparece solo si la pantalla siguiente tarda. */
const SHOW_AFTER_MS = 100
/** Una vez visible, se queda lo justo para que se vea que terminó. */
const MIN_VISIBLE_MS = 200

/**
 * La barra fina de arriba mientras se prepara la pantalla siguiente: el código de
 * esa pantalla y lo que revisa antes de abrir (la sesión, el permiso). En el
 * celular no hay puntero que la prepare antes del toque, y la app instalada no
 * tiene la barra del navegador: sin esto, un toque que tarda no da ninguna señal.
 * Sale del estado del router, no de un temporizador propio. Lo que llega después
 * (los datos de la pantalla ya abierta) lo dice el esqueleto de cada pantalla.
 */
export function NavigationProgress() {
  const busy = useRouterState({ select: (state) => state.status === "pending" || state.isLoading })
  const [shown, setShown] = useState(false)
  const [since, setSince] = useState(0)

  useEffect(() => {
    if (busy && !shown) {
      const timer = setTimeout(() => {
        setShown(true)
        setSince(Date.now())
      }, SHOW_AFTER_MS)
      return () => clearTimeout(timer)
    }
    if (!busy && shown) {
      const timer = setTimeout(() => setShown(false), Math.max(0, since + MIN_VISIBLE_MS - Date.now()))
      return () => clearTimeout(timer)
    }
    return undefined
  }, [busy, shown, since])

  if (!shown) return null
  return (
    <div
      role="progressbar"
      aria-label="Cargando la página"
      className="pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-[100] h-0.5 overflow-hidden"
    >
      <div className={`h-full w-full bg-primary ${busy ? "nav-progress" : "opacity-0 transition-opacity duration-200"}`} />
    </div>
  )
}
