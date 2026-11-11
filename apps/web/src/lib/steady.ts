// Una escena que se mueve no cambia de alto: lo que está debajo (un enlace, un botón, la sección
// siguiente) no se corre mientras alguien intenta tocarlo. Es la regla de toda la web: el movimiento
// ocurre dentro de la caja de la escena, nunca empuja la página.
import { type RefObject, useLayoutEffect, useRef } from "react"

/**
 * Fija el alto mínimo de la escena en el mayor que ha tenido con su ancho actual.
 *
 * Cada escena llega del servidor en su estado final, que es el más alto: aquí se mide antes de que
 * vuelva al primer paso, así la caja ya ocupa lo que va a necesitar y lo que aparece después entra
 * en un espacio reservado. Si un paso intermedio resulta más alto, la caja crece esa vez y no vuelve
 * a encogerse. Con otro ancho (girar el teléfono, cambiar la ventana) el alto de antes ya no vale y
 * se mide de nuevo. Una caja que no se ve pero ocupa lugar (`visibility: hidden`, fuera del flujo) se
 * mide igual: así una pestaña que aún no se abrió ya sabe cuánto va a medir.
 *
 * La escena debe dejar lo que se toca arriba del contenido que cambia o pegado al borde de abajo
 * (`margin-top: auto`): dentro de una caja fija, lo que va después de una lista que crece se mueve.
 */
export function useSteadyHeight<T extends HTMLElement = HTMLDivElement>(
  /** La referencia que la escena ya tiene de su caja, si la tiene; si no, se crea una. */
  given?: RefObject<T | null>,
): RefObject<T | null> {
  const own = useRef<T | null>(null)
  const ref = given ?? own

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let width = el.offsetWidth
    let floor = el.offsetHeight
    el.style.minHeight = `${floor}px`
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      // Oculta (otra pestaña de la demo): se queda con lo que ya se sabe.
      if (el.offsetWidth === 0) return
      if (el.offsetWidth !== width) {
        width = el.offsetWidth
        el.style.minHeight = ""
        floor = el.offsetHeight
      } else {
        floor = Math.max(floor, el.offsetHeight)
      }
      el.style.minHeight = `${floor}px`
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])

  return ref
}
