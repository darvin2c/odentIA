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
