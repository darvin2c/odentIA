import { useBlocker, useRouterState, type UseBlockerOpts } from "@tanstack/react-router"
import { useEffect, useRef } from "react"

/**
 * `useBlocker` para un borrador, con diálogo propio. Tras «Descartar y salir» la
 * pantalla sigue montada hasta que llega el destino; si en ese rato se vuelve
 * atrás, el bloqueo preguntaría otra vez con un diálogo que se iría con ella, y
 * esa navegación quedaría esperando para siempre: la dirección cambia y la
 * pantalla no. Por eso, lo descartado deja de bloquear hasta terminar de navegar.
 *
 * `keptInPage`: la pantalla mantiene montado el borrador mientras no cambie de
 * ruta (sus pestañas y filtros solo cambian la búsqueda). Entonces solo se
 * pregunta al ir a otra ruta: avisar que se perderá lo que sigue ahí sería falso.
 */
export function useDraftBlocker({ keptInPage = false, ...options }: Omit<UseBlockerOpts, "withResolver"> & { keptInPage?: boolean }) {
  const discarded = useRef(false)
  const blocker = useBlocker({
    ...options,
    withResolver: true,
    shouldBlockFn: (args) =>
      !discarded.current && !(keptInPage && args.current.pathname === args.next.pathname) && options.shouldBlockFn(args),
  })
  // Si al terminar sigue aquí (se volvió antes de que llegara el destino), su borrador vuelve a cuidarse.
  const navigating = useRouterState({ select: (state) => state.isLoading })
  useEffect(() => {
    if (!navigating) discarded.current = false
  }, [navigating])
  if (blocker.status !== "blocked") return blocker
  return {
    ...blocker,
    proceed: () => {
      discarded.current = true
      blocker.proceed()
    },
  }
}
