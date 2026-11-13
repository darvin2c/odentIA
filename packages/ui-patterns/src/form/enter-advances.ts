import type * as React from "react"

/** Lo que recibe el foco con Tab dentro del formulario. */
const STOPS = "input, textarea, select, button, [role=combobox], [tabindex]"

/** Campos de una línea: en ellos Enter (o «Ir» en el teléfono) enviaría el formulario. */
const NOT_TYPED = new Set(["button", "submit", "reset", "checkbox", "radio", "file", "image", "range", "color", "hidden"])

/**
 * `onKeyDown` del `<form>` de un cuestionario de una sola página: Enter en una
 * respuesta de una línea pasa a la pregunta siguiente (la parada siguiente de
 * Tab) y nunca envía; en la última lleva al botón de enviar. Así solo el botón
 * envía: en un teléfono, la tecla «Ir» mandaba todo con las preguntas
 * siguientes vacías. En un texto largo Enter sigue siendo un salto de línea, y
 * en un botón o una opción, su acción.
 */
export function advanceOnEnter(event: React.KeyboardEvent<HTMLFormElement>): void {
  const target = event.target
  if (event.key !== "Enter" || event.nativeEvent.isComposing || event.defaultPrevented) return
  if (!(target instanceof HTMLInputElement) || NOT_TYPED.has(target.type)) return
  event.preventDefault()
  // En un buscador (país, medicamento) Enter elige de su lista: ni envía ni cambia de pregunta.
  if (target.getAttribute("role") === "combobox") return
  const stops = [...event.currentTarget.querySelectorAll<HTMLElement>(STOPS)].filter(
    (stop) =>
      stop === target ||
      (stop.tabIndex !== -1 && !stop.matches(":disabled, [aria-disabled=true]") && stop.closest("[hidden], [inert]") === null),
  )
  stops[stops.indexOf(target) + 1]?.focus()
}
