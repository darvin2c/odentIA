/**
 * El Código de Cuenta Interbancario (CCI) del Perú: 20 números que la Cámara de Compensación
 * Electrónica (CCE) usa para las transferencias entre bancos. Se arma así:
 *
 * - 3: la entidad (el banco: 002 es el BCP, 003 Interbank, 011 BBVA…);
 * - 3: la oficina o plaza;
 * - 12: la cuenta;
 * - 2: los dígitos de control, el primero de la entidad y la oficina, el segundo de la cuenta.
 *
 * Cada dígito de control sale igual: de izquierda a derecha se multiplica por 1, 2, 1, 2…; si el
 * producto tiene dos cifras, se suman; el dígito es lo que le falta a la suma para la decena
 * siguiente (0 si ya es decena). Lo comprueban en `cci.test.ts` CCI publicados por quienes los
 * usan para recibir dinero.
 *
 * La misma cuenta está en la pantalla (`apps/web/src/lib/cobros.ts`) para decirlo mientras se
 * escribe; quien decide es el servidor.
 */

function controlDigit(digits: string): number {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    const product = Number(digits[i]) * (i % 2 === 0 ? 1 : 2)
    sum += product > 9 ? product - 9 : product
  }
  return (10 - (sum % 10)) % 10
}

/** Solo los números: «002-191-002345678012-53» → «00219100234567801253». */
export function cciDigits(text: string): string {
  return text.replace(/[\s.-]/g, "")
}

export type CciProblem = "largo" | "numeros" | "control"

/** Qué tiene de malo un CCI, o null si está bien (20 números y sus dígitos de control). */
export function cciProblem(text: string): CciProblem | null {
  const digits = cciDigits(text)
  if (!/^\d*$/.test(digits)) return "numeros"
  if (digits.length !== 20) return "largo"
  const first = controlDigit(digits.slice(0, 6))
  const second = controlDigit(digits.slice(6, 18))
  return digits.slice(18) === `${first}${second}` ? null : "control"
}

/** El banco del CCI: sus tres primeros números. */
export function cciBank(text: string): string {
  return cciDigits(text).slice(0, 3)
}

/** «002 191 002345678012 53», como lo muestran los bancos. */
export function cciText(digits: string): string {
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 18)} ${digits.slice(18)}`
}
