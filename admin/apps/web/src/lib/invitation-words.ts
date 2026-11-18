/**
 * Cómo se dice el vencimiento de una invitación: la misma frase en Inicio, la
 * ficha › Equipo y el aviso de «Reenviar». «Vence» es solo de las
 * invitaciones; los días se leen en Lima, como el resto de la administración.
 */
import { supportDay } from "./support-words"

const dayKeyFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" })
const dayKey = (date: Date): string => dayKeyFormat.format(date)

/**
 * «vence hoy», «vence el sáb 14 nov», «venció hoy» o «venció el mar 10 nov».
 * `urgent` (el rojo) solo para lo vencido y lo de hoy.
 */
export function invitationDueWords(expiresAt: string, now: Date = new Date()): { text: string; expired: boolean; urgent: boolean } {
  const expires = new Date(expiresAt)
  const expired = expires.getTime() <= now.getTime()
  const today = dayKey(expires) === dayKey(now)
  const verb = expired ? "venció" : "vence"
  return { text: today ? `${verb} hoy` : `${verb} el ${supportDay(expiresAt)}`, expired, urgent: expired || today }
}

/** Un día de Lima («2026-11-12») como «jue 12 nov»: a mediodía de Lima, para que ninguna zona lo corra de día. */
export const limaDayWords = (day: string): string => supportDay(`${day}T17:00:00Z`)
