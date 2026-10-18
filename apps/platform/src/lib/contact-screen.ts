import type { ContactScreen, ContactScreenView } from "./crm"
import { activeOrgLocale, activeOrgTimeZone } from "./locale"

/**
 * Spam y Bloquear dichos con palabras (ADR 0054). El servidor decide el estado
 * y su motivo; aquí solo se dice. Nunca se muestra el código.
 */

/** Por qué está en Spam, como se lee en la fila y en el aviso. */
const SPAM_REASON_WORDS: Record<string, string> = {
  repeticion: "Repitió el mismo texto",
  publicidad: "Publicidad",
  estafa: "Parece una estafa",
  cadena: "Mensaje en cadena",
  respuesta_automatica: "Respuesta automática de otro negocio",
  venta: "Ofrece servicios a la clínica",
  equipo: "Lo marcó el equipo",
}

/** Motivos para bloquear, en el orden en que se ofrecen. */
export const BLOCK_REASON_OPTIONS = [
  { value: "acoso", label: "Acoso o insultos" },
  { value: "amenazas", label: "Amenazas" },
  { value: "estafa", label: "Estafa o suplantación" },
  { value: "otro", label: "Otro" },
] as const

const BLOCK_REASON_WORDS: Record<string, string> = Object.fromEntries(
  BLOCK_REASON_OPTIONS.map((option) => [option.value, option.label]),
)

/** El motivo de la fila: «Repitió el mismo texto», «Amenazas». */
export function screenReasonWords(screen: ContactScreen, reason: string | null | undefined): string {
  if (screen === "spam") return SPAM_REASON_WORDS[reason ?? ""] ?? "Spam"
  return BLOCK_REASON_WORDS[reason ?? ""] ?? "Bloqueado"
}

/** Un día corto en la zona de la clínica: «16 oct». */
export function screenDayWords(iso: string | null | undefined): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short", timeZone: activeOrgTimeZone() })
}

/** El aviso de arriba de la conversación en Spam (tablero 4). */
export function spamNoticeWords(view: ContactScreenView): { title: string; detail: string } {
  const day = screenDayWords(view.at)
  const who = view.byName ? `Lo marcó ${view.byName}` : "Lo decidió el agente"
  const reason = view.byName ? null : screenReasonWords("spam", view.reason)
  return {
    title: reason ? `Spam: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}` : "Spam",
    detail: `${who}${day ? ` el ${day}` : ""}. El agente no le responde y no se cobra.`,
  }
}

/** El aviso rojo de una persona bloqueada (tablero 5b). */
export function blockedNoticeWords(view: ContactScreenView): { title: string; detail: string | null } {
  const day = screenDayWords(view.at)
  return {
    title: `Bloqueado por ${view.byName ?? "el equipo"}${day ? ` el ${day}` : ""} · ${screenReasonWords("blocked", view.reason)}`,
    detail: view.note ? `«${view.note}»` : null,
  }
}

/** Salió sola de Spam (decisión 9b): con qué escribió y quién la había marcado. */
export function leftSpamWords(view: ContactScreenView): string | null {
  if (!view.leftSpam) return null
  const marked = view.leftSpam.markedByName
    ? `lo había marcado ${view.leftSpam.markedByName}${view.leftSpam.markedAt ? ` el ${screenDayWords(view.leftSpam.markedAt)}` : ""}`
    : "lo había decidido el agente"
  return `Salió de Spam al escribir algo para la clínica · ${marked}`
}
