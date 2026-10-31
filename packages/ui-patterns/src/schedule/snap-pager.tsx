/**
 * Deslizar de lado para pasar a lo anterior o a lo siguiente: tres paneles que el
 * dedo arrastra con el desplazamiento nativo del navegador, así que sigue al dedo
 * y respeta el scroll vertical de cada panel. Al soltar en un vecino avisa con
 * `onStep` y, con la nueva posición (`position`), vuelve al panel del centro sin
 * que se note. Deslizar nunca es la única vía: la pantalla ofrece también tocar.
 */

import { cn } from "@odentia/ui"
import * as React from "react"

/** Espera tras el último movimiento para dar el deslizamiento por terminado. */
const SETTLE_MS = 90

export interface ScheduleSnapPagerProps {
  /** Lo que identifica el panel del centro («2026-10-31»): al cambiar, vuelve al centro. */
  position: string
  /** Pinta el panel: -1 el anterior, 0 el actual y 1 el siguiente. */
  renderPane: (offset: -1 | 0 | 1) => React.ReactNode
  onStep: (direction: -1 | 1) => void
  /** Nombre accesible del grupo. */
  "aria-label"?: string
  className?: string
  paneClassName?: string
}

export function ScheduleSnapPager({
  position,
  renderPane,
  onStep,
  "aria-label": ariaLabel,
  className,
  paneClassName,
}: ScheduleSnapPagerProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const timer = React.useRef<number | undefined>(undefined)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `position` es justo lo que manda volver al centro.
  React.useLayoutEffect(() => {
    const root = rootRef.current
    if (root) root.scrollLeft = root.clientWidth
  }, [position])

  React.useEffect(() => () => window.clearTimeout(timer.current), [])

  const onScroll = () => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const root = rootRef.current
      if (!root || root.clientWidth === 0) return
      const pane = Math.round(root.scrollLeft / root.clientWidth)
      if (pane === 0) onStep(-1)
      else if (pane === 2) onStep(1)
    }, SETTLE_MS)
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: un fieldset trae maquetación que rompe los paneles.
    <div
      ref={rootRef}
      role="group"
      aria-label={ariaLabel}
      data-snap-pager
      onScroll={onScroll}
      className={cn(
        "flex min-w-0 snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {([-1, 0, 1] as const).map((offset) => (
        <div
          key={offset}
          // Los vecinos se ven al deslizar, pero el teclado y el lector solo recorren el actual.
          inert={offset !== 0 || undefined}
          data-pane={offset}
          className={cn("min-w-0 flex-[0_0_100%] snap-start [scroll-snap-stop:always]", paneClassName)}
        >
          {renderPane(offset)}
        </div>
      ))}
    </div>
  )
}
