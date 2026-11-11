// Una escena que se mueve no cambia de alto: lo que está debajo (un enlace, un botón, la sección
// siguiente) no se corre mientras alguien intenta tocarlo. Es la regla de toda la web: el movimiento
// ocurre dentro de la caja de la escena, nunca empuja la página.
import { type RefObject, useLayoutEffect, useRef } from "react"

/**
 * Fija el alto mínimo de la escena en el de su estado final, con su ancho actual.
 *
 * Cada escena llega del servidor en su estado final, que es el más alto: aquí se mide antes de que
 * vuelva al primer paso, así la caja ya ocupa lo que va a necesitar y lo que aparece después entra
 * en un espacio reservado. Si un paso intermedio resulta más alto, la caja crece esa vez y no vuelve
 * a encogerse.
 *
 * Con otro ancho (girar el teléfono, cambiar la ventana) el alto de antes ya no vale. Si la escena da
 * `toFinal`, se la lleva a su estado final y se mide ese; si no, se mide lo que muestra. Por eso una
 * escena cuyo alto cambia mientras avanza da `toFinal`, y una que reserva sus variantes con `.fit`
 * (todas en la misma celda) no lo necesita: mide siempre lo mismo.
 *
 * Una caja oculta (otra pestaña de la demo) se queda con lo que ya sabía. Una que no se ve pero ocupa
 * lugar (`visibility: hidden`) se mide igual. La escena debe dejar lo que se toca arriba del contenido
 * que cambia o pegado al borde de abajo (`margin-top: auto`).
 */
export function useSteadyHeight<T extends HTMLElement = HTMLDivElement>(
  /** La referencia que la escena ya tiene de su caja, si la tiene; si no, se crea una. */
  given?: RefObject<T | null>,
  /** Lleva la escena a su estado final (y detiene lo que la hace avanzar) para medirlo. */
  toFinal?: () => void,
): RefObject<T | null> {
  const own = useRef<T | null>(null)
  const ref = given ?? own
  const final = useRef(toFinal)
  final.current = toFinal

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let width = el.offsetWidth
    let floor = el.offsetHeight
    let waiting = 0
    el.style.minHeight = `${floor}px`
    if (typeof ResizeObserver === "undefined") return
    /** Mide de nuevo desde cero: el alto de antes era de otro ancho. */
    const remeasure = () => {
      el.style.minHeight = ""
      floor = el.offsetHeight
      el.style.minHeight = `${floor}px`
    }
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth === 0) return
      if (el.offsetWidth === width) {
        floor = Math.max(floor, el.offsetHeight)
        el.style.minHeight = `${floor}px`
        return
      }
      width = el.offsetWidth
      const toEnd = final.current
      if (!toEnd) {
        remeasure()
        return
      }
      // La escena pasa a su estado final; se mide cuando React ya lo pintó (dos cuadros después).
      toEnd()
      cancelAnimationFrame(waiting)
      waiting = requestAnimationFrame(() => {
        waiting = requestAnimationFrame(remeasure)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(waiting)
    }
  }, [ref])

  return ref
}
