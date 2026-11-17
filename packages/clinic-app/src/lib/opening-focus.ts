/**
 * Si, al abrir la atención, el cursor va solo al motivo (P10): es una ayuda de teclado, para que
 * el primer Tab no vuelva al principio de la página. Solo si nada más tomó el foco (la pieza
 * pedida por enlace, un aviso). En el teléfono o la tablet (puntero grueso) no: enfocar un campo
 * de texto puede subir el teclado y tapar media atención sin que nadie lo haya pedido.
 */
export function focusesReasonOnOpen(
  active: Element | null = document.activeElement,
  touch: boolean = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches,
): boolean {
  if (touch) return false
  return active === null || active === document.body
}
