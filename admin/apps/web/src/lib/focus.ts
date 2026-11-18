import { useCallback, useLayoutEffect, useRef } from "react"

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])"

/**
 * A dónde va el foco cuando una fila se va: a la fila vecina (la siguiente o
 * la anterior) y, si no hay, al título de la pantalla.
 */
function targetAfterLeaving(row: HTMLElement): HTMLElement | null {
  for (const neighbour of [row.nextElementSibling, row.previousElementSibling]) {
    const target = neighbour?.querySelector<HTMLElement>(FOCUSABLE)
    if (target) return target
  }
  const title = document.querySelector<HTMLElement>("main h1")
  if (title && !title.hasAttribute("tabindex")) title.setAttribute("tabindex", "-1")
  return title
}

const lost = () => !document.activeElement || document.activeElement === document.body

/**
 * Una fila que se va de la lista porque alguien la decidió (aprobar, «Ahora
 * no», «Salió», «Hecho», «Mover») se lleva el foco con ella, y el teclado
 * volvía al principio de la página. Al irse, si el foco estaba en ella o ya se
 * había perdido, pasa a la fila vecina o al título. Si estaba en un menú o un
 * calendario de la fila, que al cerrarse lo devuelve a un botón que ya no
 * existe, se mira otra vez un momento después. Solo tras `markLeaving`: una
 * fila que desaparece por un filtro o por cambiar de pantalla no mueve nada.
 */
export function useFocusOnLeave<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const leaving = useRef(false)
  useLayoutEffect(() => {
    // La fila de este montaje: al desmontar, React ya soltó la ref, pero la
    // limpieza corre antes de quitarla del documento y sus vecinas siguen ahí.
    const row = ref.current
    return () => {
      if (!leaving.current || !row?.isConnected) return
      const target = targetAfterLeaving(row)
      if (!target) return
      if (lost() || row.contains(document.activeElement)) target.focus()
      else
        window.setTimeout(() => {
          if (lost() && target.isConnected) target.focus()
        }, 300)
    }
  }, [])
  const markLeaving = useCallback(() => {
    leaving.current = true
  }, [])
  return { ref, markLeaving }
}

/**
 * Tras cerrar un diálogo cuyo botón de origen ya no existe (la propuesta
 * aceptada pierde «La aceptó»), el diálogo devuelve el foco a la nada. Un
 * momento después, si se perdió, va a lo primero que se pueda usar de `row`
 * o, sin nada, al título de la pantalla.
 */
export function focusInsideLater(row: () => Element | null): void {
  window.setTimeout(() => {
    if (!lost()) return
    const target = row()?.querySelector<HTMLElement>(FOCUSABLE)
    if (target) {
      target.focus()
      return
    }
    const title = document.querySelector<HTMLElement>("main h1")
    if (title && !title.hasAttribute("tabindex")) title.setAttribute("tabindex", "-1")
    title?.focus()
  }, 300)
}

/**
 * Lo que se decide en la ficha (venta cerrada, alta, «No por ahora») cambia
 * su cabecera y el botón que abrió el panel ya no está: el foco vuelve a
 * «Decides tú» o, si ya no existe, al próximo paso.
 */
export const fichaDecisionArea = (): Element | null =>
  document.querySelector("main section[aria-labelledby=ficha-decide]") ??
  document.querySelector("main section[aria-labelledby=ficha-proximo]")
