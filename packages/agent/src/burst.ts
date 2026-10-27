/**
 * ¿La persona dejó el mensaje a medias? En WhatsApp se escribe en pedazos
 * («tengo» / «un problema» / «en el diente»): responder al primer silencio
 * corto deja una respuesta a medias. Por forma, sin modelo, para que la espera
 * sea predecible (ADR 0097).
 */

/** Silencio que se espera cuando el mensaje parece a medias (el normal es `AGENT_BURST_WINDOW_SECONDS`). */
export const UNFINISHED_QUIET_MS = 12_000

/** Palabras que piden lo que sigue: un mensaje que termina en ellas no está completo. */
const CONTINUES = new Set([
  "a", "al", "con", "de", "del", "el", "en", "es", "la", "las", "lo", "los", "me", "mi", "mis", "o", "para", "pero",
  "por", "porque", "que", "se", "su", "sus", "te", "tu", "un", "una", "y", "tengo", "quiero", "quisiera", "queria",
  "necesito", "hay", "tiene", "estoy", "esta", "como", "cuando", "donde",
])

function plain(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\p{Extended_Pictographic}‍️]/gu, "")
    .trim()
}

/**
 * `said`: lo que escribió desde la última respuesta, en orden. `answering`: la
 * última respuesta del agente terminó en pregunta, así que algo corto
 * («miraflores», «sí», «a las 3») es una respuesta completa.
 */
export function looksUnfinished(said: readonly string[], answering: boolean): boolean {
  const text = plain(said.join(" "))
  if (!text || /[.?!…]$/.test(text)) return false
  const words = text.split(/\s+/).filter(Boolean)
  const last = words[words.length - 1] ?? ""
  if (CONTINUES.has(last)) return true
  return !answering && words.length <= 4
}
