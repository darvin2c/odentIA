/**
 * Con `NODE_ENV=production` el modo de envío se elige: sin `CHANNEL_SENDER_MODE`
 * el worker simularía cada mensaje (los pacientes no reciben nada y el hilo lo
 * muestra como enviado), así que no arranca. Fuera de producción falta = `mock`.
 */
export function senderModeStartProblem(data: { NODE_ENV?: string; CHANNEL_SENDER_MODE?: string }): string | null {
  if (data.NODE_ENV !== "production" || data.CHANNEL_SENDER_MODE) return null
  return "En producción CHANNEL_SENDER_MODE es obligatoria: live para enviar de verdad, mock solo para simular a propósito"
}
