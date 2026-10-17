/**
 * La ventana para escribir sin mensaje aprobado (ADR 0042, «Una puerta para
 * escribirle a alguien»). WhatsApp, Messenger e Instagram dejan escribir
 * texto libre hasta 24 horas después del último mensaje de la persona. Todo
 * lo que decide si la ventana está abierta (la vía de un mensaje, la Bandeja,
 * los documentos, «Probar línea», la despedida) usa esta función y su único
 * margen: lo que se decide ahora puede salir unos minutos después (un lote,
 * un reintento), y un mensaje que llega pasada la hora lo rechaza el proveedor.
 *
 * Módulo sin dependencias para que lo usen sin ciclos `conversations.ts`, la
 * ruta de cada mensaje y los documentos.
 */

/** Lo que da el proveedor: 24 horas desde el último mensaje de la persona. */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000
/** El único margen sobre esas 24 horas. */
export const WINDOW_MARGIN_MS = 15 * 60 * 1000

/** ¿Está abierta la ventana en `at`? Sin mensaje de la persona, nunca. */
export function windowOpen(lastInboundAt: Date | string | null | undefined, at: Date | number = Date.now()): boolean {
  if (!lastInboundAt) return false
  const last = typeof lastInboundAt === "string" ? Date.parse(lastInboundAt) : lastInboundAt.getTime()
  if (Number.isNaN(last)) return false
  const now = typeof at === "number" ? at : at.getTime()
  return now - last < WHATSAPP_WINDOW_MS - WINDOW_MARGIN_MS
}
