import type * as React from "react"

/** Lo que recibe el foco con Tab dentro del formulario. */
const STOPS = "input, textarea, select, button, [role=combobox], [tabindex]"

/** Campos de una línea: en ellos Enter (o «Ir» en el teléfono) enviaría el formulario. */
const NOT_TYPED = new Set(["button", "submit", "reset", "checkbox", "radio", "file", "image", "range", "color", "hidden"])

/**
 * `onKeyDown` del `<form>` de un cuestionario de una sola página: Enter pasa a
 * la pregunta siguiente y nunca envía ni responde; en la última lleva al botón
 * de enviar. Así solo el botón envía: en un teléfono, la tecla «Ir» mandaba
 * todo con las preguntas siguientes vacías.
 *
 * - En una respuesta de una línea, Enter no envía nunca, tampoco mientras el
 *   teclado compone una palabra (ahí solo la confirma y el foco no se mueve).
 * - En una opción de un grupo de radios, Enter no la marca (se marca con
 *   Espacio o con las flechas): sigue a la pregunta siguiente.
 * - La parada siguiente es la de Tab, salvo lo marcado con `data-enter-skip`
 *   (un «Quitar respuesta»): Enter repetido no cae en un botón que cambie algo.
 * - En un texto largo Enter sigue siendo un salto de línea, y en un botón, su
 *   acción.
 */
export function advanceOnEnter(event: React.KeyboardEvent<HTMLElement>): void {
  const target = event.target
  if (event.key !== "Enter" || !(target instanceof HTMLElement)) return
  const radio = target.getAttribute("role") === "radio"
  if (!radio) {
    // Lo que ya atendió su propio control (un buscador que elige de su lista) no se toca.
    if (event.defaultPrevented) return
    if (!(target instanceof HTMLInputElement) || NOT_TYPED.has(target.type)) return
  }
  event.preventDefault()
  if (event.nativeEvent.isComposing) return
  // En un buscador (país, medicamento) Enter elige de su lista: ni envía ni cambia de pregunta.
  if (target.getAttribute("role") === "combobox") return
  const stops = [...event.currentTarget.querySelectorAll<HTMLElement>(STOPS)].filter(
    (stop) =>
      stop === target ||
      (stop.tabIndex !== -1 &&
        !stop.matches(":disabled, [aria-disabled=true], [data-enter-skip]") &&
        stop.closest("[hidden], [inert]") === null),
  )
  stops[stops.indexOf(target) + 1]?.focus()
}
