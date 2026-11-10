/**
 * Cómo se dice en qué sesión va un tratamiento de varias (una endodoncia en
 * dos, la ortodoncia mensual, una terapia): «sesión 2 de 2». Lo usan la
 * Agenda, la cita, la reserva, «Qué sigue» y el cierre de la atención, para
 * que se diga igual en todas partes.
 *
 * `n` es la sesión de la que se habla y `m` las previstas. Si ya se pasó de lo
 * previsto no se dice «3 de 2»: «sesión 3 (2 previstas)».
 */
export function sessionWords(n: number, m: number): string {
  if (n > m) return `sesión ${n} (${m} ${m === 1 ? "prevista" : "previstas"})`
  return `sesión ${n} de ${m}`
}

/**
 * Si vale la pena decirlo: un tratamiento de una sola sesión no dice
 * «sesión 1 de 1», salvo que ya vaya por una de más.
 */
export function showsSession(n: number, m: number): boolean {
  return m > 1 || n > m
}

/**
 * Cómo se dice una sesión ya hecha en la historia (la tarjeta de la atención,
 * la historia de la pieza): «sesión 1 de 2» mientras el tratamiento sigue, y
 * «sesión 2 de 2 · tratamiento terminado» en la que lo terminó (también si se
 * terminó antes de sus previstas). Una sesión de un tratamiento en curso nunca
 * se dice «Realizado» a secas (tercer repaso del 9 nov, E8 y E12). Lo de una
 * sola sesión no dice su sesión: `null`.
 */
export function doneSessionWords(n: number, m: number, finished: boolean): string | null {
  if (!showsSession(n, m)) return null
  return finished ? `${sessionWords(n, m)} · tratamiento terminado` : sessionWords(n, m)
}
