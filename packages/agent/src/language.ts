/**
 * Si un texto está en español o en inglés, por sus palabras más comunes y sin
 * modelo (auditoría del ADR 0104): a quien escribía en inglés Sofi a veces le
 * respondía en español, aunque el prompt le pedía su idioma. Solo distingue
 * esos dos; lo demás queda como no se sabe y sigue la regla general del prompt.
 */

/** Palabras que casi solo se usan en un idioma: las que comparten («no», «a», «me») no cuentan. */
const SPANISH = new Set([
  "el", "la", "los", "las", "de", "del", "que", "y", "en", "un", "una", "es", "por", "para", "con", "se", "lo", "mi", "tu",
  "su", "te", "le", "al", "como", "mas", "pero", "hola", "gracias", "si", "quiero", "tengo", "puedo", "cita", "hay", "cuanto",
  "esta", "este", "tiene", "tienen", "muy", "bien", "porque", "cuando", "donde", "hoy", "manana", "tarde", "favor", "ya", "estoy",
])
const ENGLISH = new Set([
  "the", "an", "is", "are", "you", "my", "your", "have", "has", "do", "does", "can", "could", "would", "what", "how", "for",
  "with", "this", "that", "it", "at", "on", "in", "to", "and", "of", "hi", "hello", "thanks", "thank", "please", "yes", "want",
  "need", "appointment", "there", "today", "tomorrow", "when", "am", "be", "was", "will", "im", "it's", "i'm", "don't", "where",
])

/** Nulo si no se distingue: un «ok», un número, un emoji o mitad y mitad. */
export function languageOf(text: string | null | undefined): "es" | "en" | null {
  const words = (text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[a-z']+/g) ?? []
  let es = 0
  let en = 0
  for (const word of words) {
    if (SPANISH.has(word)) es += 1
    if (ENGLISH.has(word)) en += 1
  }
  if (es + en < 3) return null
  if (en >= 2 * Math.max(es, 1)) return "en"
  if (es >= 2 * Math.max(en, 1)) return "es"
  return null
}
