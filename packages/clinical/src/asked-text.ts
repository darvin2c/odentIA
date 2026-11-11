/**
 * Lo que alguien del equipo escribe en el buscador o en la Ayuda: si es una
 * pregunta y si puede ser el dato de una persona. Lo usan el buscador de la
 * plataforma (qué fila va primero) y la Ayuda (qué no viaja a un modelo,
 * ADR 0146), con la misma regla.
 */

/** Lo escrito es una pregunta, no un nombre: «¿cómo bloqueo un horario?» no se ofrece como paciente nuevo. */
export function looksLikeQuestion(text: string): boolean {
  // Sin `\b`: en JavaScript, «é» no es una letra para él y «qué es» no coincidiría.
  return /[¿?]/.test(text) || /^(c[oó]mo|d[oó]nde|qu[eé]|cu[aá]l|cu[aá]ndo|cu[aá]nt[oa]s?|qui[eé]n|por qu[eé]|porque|puedo|se puede|quiero|necesito|no puedo|no me|no encuentro)(?!\p{L})/iu.test(text.trim())
}

/** Las palabras de un texto: letras (con tildes) o cifras seguidas. */
const WORDS = /[\p{L}\p{M}]+|\d+/gu

/**
 * Puede ser el dato de una persona: un teléfono, un documento o un número de
 * historia (solo cifras, o cuatro o más seguidas aunque las separen espacios,
 * puntos o guiones), un correo, o un nombre suelto (tres palabras o menos que
 * no son una pregunta: «Elena Pérez Quispe»). Lo que lo parece no viaja a un
 * modelo: se responde sin él.
 */
export function mayIdentifySomeone(text: string): boolean {
  const asked = text.trim()
  if (!asked) return false
  if (/^[\d\s+().-]+$/.test(asked)) return true
  if (/\d{4,}/.test(asked.replace(/(\d)[\s.-]+(?=\d)/g, "$1"))) return true
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(asked)) return true
  return (asked.match(WORDS) ?? []).length <= 3 && !looksLikeQuestion(asked)
}

/**
 * Lo escrito, sin lo que puede ser el dato de una persona, para que pueda
 * viajar a un modelo: «¿cómo cobro 1200 mitad Yape?» viaja sin la cifra. Quita
 * correos y cifras; si lo que queda sigue pareciendo un dato (un nombre
 * suelto, nada), devuelve nulo y no viaja.
 */
export function withoutPersonData(text: string): string | null {
  if (!mayIdentifySomeone(text)) return text.trim() || null
  const cleaned = text
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, " ")
    .replace(/\d[\d\s.,+()/-]*\d|\d/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned && !mayIdentifySomeone(cleaned) ? cleaned : null
}
