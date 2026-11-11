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
