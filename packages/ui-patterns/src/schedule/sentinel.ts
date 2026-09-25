/**
 * Sentinela de scroll infinito: un div vacío al borde del contenedor que,
 * al hacerse visible, pide más datos (`IntersectionObserver`). Se usa en los
 * cuatro sentidos del timeline: izquierda/derecha en el eje horizontal y
 * arriba/abajo en el stream vertical.
 *
 * Dos reglas duras:
 * - `root` debe ser el contenedor de scroll: con el viewport del documento
 *   los antepasados con overflow recortan la intersección y el `rootMargin`
 *   nunca dispara antes del borde visible.
 * - El observer se crea en un efecto, no en el ref callback: React adjunta
 *   los refs de abajo hacia arriba y el root del padre aún es null cuando el
 *   ref de la sentinela corre.
 *
 * `disabled` corta la petición mientras hay una carga en vuelo; al bajar, el
 * observer se recrea y, si la sentinela sigue en margen, pide el siguiente
 * tramo (precarga hasta cubrir el colchón; no hay cascada infinita porque la
 * sentinela sale del margen al crecer el contenido).
 */

import * as React from "react"

export function useInfiniteSentinel(
  onReach: () => void,
  options?: { disabled?: boolean; rootMargin?: string; root?: () => Element | null },
): (node: HTMLElement | null) => void {
  const { disabled = false, rootMargin = "200px", root } = options ?? {}
  const [node, setNode] = React.useState<HTMLElement | null>(null)
  const savedReach = React.useRef(onReach)
  savedReach.current = onReach

  React.useEffect(() => {
    if (!node || disabled || typeof IntersectionObserver !== "function") return
    let fired = false
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (!entry) return
        if (!entry.isIntersecting) {
          fired = false
          return
        }
        if (fired) return
        fired = true
        savedReach.current()
      },
      { root: root?.() ?? null, rootMargin },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, disabled, rootMargin, root])

  return setNode
}
