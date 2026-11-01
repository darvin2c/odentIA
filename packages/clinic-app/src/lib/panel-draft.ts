/**
 * Lo que se dejó escrito a medias en el panel de una persona: se guarda en este
 * navegador al escribir, sin preguntar nada, y la fila lo dice. Es una comodidad
 * de quien escribe: sin almacenamiento (ventana privada, datos borrados) el panel
 * funciona igual y solo se pierde el borrador. Es de cada persona: recepción suele
 * compartir el equipo.
 */
const key = (userId: string, conversationId: string) => `odentia.panel-draft.${userId}.${conversationId}`

export function readPanelDraft(userId: string, conversationId: string): string {
  try {
    return localStorage.getItem(key(userId, conversationId)) ?? ""
  } catch {
    return ""
  }
}

export function writePanelDraft(userId: string, conversationId: string, text: string): void {
  try {
    if (text.trim()) localStorage.setItem(key(userId, conversationId), text)
    else localStorage.removeItem(key(userId, conversationId))
  } catch {
    // Sin almacenamiento no hay borrador; lo escrito sigue en el panel abierto.
  }
}

export function hasPanelDraft(userId: string, conversationId: string): boolean {
  return readPanelDraft(userId, conversationId).trim().length > 0
}
