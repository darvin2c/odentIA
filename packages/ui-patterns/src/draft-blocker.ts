import { useBlocker, useRouterState, type UseBlockerOpts } from "@tanstack/react-router"

/**
 * La pantalla mantiene montado el borrador mientras no cambie de ruta (sus
 * pestañas y filtros solo cambian la búsqueda). `unlessChanges`: claves de la
 * búsqueda que sí cambian lo que el borrador guardaría (la sede), y por eso
 * preguntan aunque la ruta sea la misma.
 */
export interface KeptInPage {
  unlessChanges?: readonly string[]
}
import { useEffect, useRef } from "react"

/**
 * `useBlocker` para un borrador, con diálogo propio. Tras «Descartar y salir» la
 * pantalla sigue montada hasta que llega el destino; si en ese rato se vuelve
 * atrás, el bloqueo preguntaría otra vez con un diálogo que se iría con ella, y
 * esa navegación quedaría esperando para siempre: la dirección cambia y la
 * pantalla no. Por eso, lo descartado deja de bloquear hasta terminar de navegar.
 *
 * Con `keptInPage` solo se pregunta al ir a otra ruta o al cambiar una de sus
 * `unlessChanges`: avisar que se perderá lo que sigue ahí sería falso.
 */
export function useDraftBlocker({
  keptInPage,
  ...options
}: Omit<UseBlockerOpts, "withResolver"> & { keptInPage?: KeptInPage | null }) {
  const discarded = useRef(false)
  const blocker = useBlocker({
    ...options,
    withResolver: true,
    shouldBlockFn: (args) => {
      if (discarded.current) return false
      const current = args.current.search as Record<string, unknown>
      const next = args.next.search as Record<string, unknown>
      const stays =
        keptInPage != null &&
        args.current.pathname === args.next.pathname &&
        (keptInPage.unlessChanges ?? []).every((key) => JSON.stringify(current[key]) === JSON.stringify(next[key]))
      return !stays && options.shouldBlockFn(args)
    },
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
