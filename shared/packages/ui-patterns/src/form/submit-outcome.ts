/**
 * Un envío que no pasó (validación del formulario o rechazo del servidor) lo dice con este
 * evento sobre su `<form>`. La columna lateral lo escucha: el envío la desarmó por si salía bien
 * (tras guardar se suele navegar al registro creado), y si no salió, lo escrito sigue sin guardar.
 */
export const SUBMIT_REJECTED_EVENT = "odentia:submit-rejected"

export function announceSubmitRejected(root: ParentNode | null | undefined): void {
  if (typeof Element === "undefined" || !(root instanceof Element) || !root.isConnected) return
  root.dispatchEvent(new CustomEvent(SUBMIT_REJECTED_EVENT, { bubbles: true }))
}
