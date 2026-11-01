/**
 * Lo que se dejó escrito a medias en el panel de una persona: se guarda en este
 * navegador al escribir, sin preguntar nada, y la fila lo dice. Es una comodidad
 * de quien escribe: sin almacenamiento (ventana privada, datos borrados) el panel
 * funciona igual y solo se pierde el borrador.
 */
const key = (conversationId: string) => `odentia.panel-draft.${conversationId}`

export function readPanelDraft(conversationId: string): string {
  try {
    return localStorage.getItem(key(conversationId)) ?? ""
  } catch {
    return ""
  }
}

export function writePanelDraft(conversationId: string, text: string): void {
  try {
    if (text.trim()) localStorage.setItem(key(conversationId), text)
    else localStorage.removeItem(key(conversationId))
  } catch {
    // Sin almacenamiento no hay borrador; lo escrito sigue en el panel abierto.
  }
}

export function hasPanelDraft(conversationId: string): boolean {
  return readPanelDraft(conversationId).trim().length > 0
}
