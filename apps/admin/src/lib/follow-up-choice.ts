/** Cuándo volver a contactar a un prospecto: lo pendiente, un día de los que se ofrecen, otro o ninguno. */
export type FollowUpChoice = "mantener" | "manana" | "habiles" | "semana" | "otra" | "cerrar"
export const FOLLOW_UP_CHOICES: readonly string[] = ["mantener", "manana", "habiles", "semana", "otra", "cerrar"]

/**
 * Lo que viene elegido al abrir la solicitud. Con una fecha pendiente de hoy
 * en adelante, «Mantener»; si ya pasó («Tocaba el…»), no se puede mantener (el
 * servidor no guarda un día pasado) y viene «Mañana». Nunca viene elegido
 * cerrar el seguimiento: eso es «No volver a contactar», a propósito. Sin
 * fecha pendiente no viene nada: anotar sin fecha no cierra nada.
 */
export function openingFollowUpChoice(pending: string | null, today: string | null): FollowUpChoice | null {
  if (pending === null || today === null) return null
  return pending >= today ? "mantener" : "manana"
}

/**
 * Qué pasa en Inicio con lo que se va a anotar (`waitlistHomeRows`), dicho a
 * quien anota. Con fecha, ese día vuelve a salir; si es solo de
 * administración, a soporte no. Sin fecha no vuelve por el seguimiento. Una
 * invitación por vencer o vencida (`invitationSoon`) la tiene en «Prospectos
 * por responder» igual, con fecha o sin ella, hasta reenviarla, que entre o
 * descartarla. No nombra «Seguimientos de hoy»: si la fila ya está en
 * «Prospectos por responder», su seguimiento va ahí como segunda línea.
 */
export function followUpHint(input: { nextDay: string | null; invitationSoon: boolean; adminOnly: boolean }): string {
  const day = input.nextDay
    ? input.adminOnly
      ? "Ese día vuelve a salir en Inicio, solo para Administración."
      : "Ese día vuelve a salir en Inicio."
    : input.invitationSoon
      ? "Sin fecha, no sale en Inicio por el seguimiento."
      : "Sin fecha, no vuelve a salir en Inicio."
  return input.invitationSoon
    ? `${day} Mientras su invitación esté por vencer o vencida, sigue en «Prospectos por responder».`
    : day
}
