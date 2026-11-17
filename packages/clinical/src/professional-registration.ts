/**
 * El número de colegiatura con que firma un profesional: solo dígitos (QA del 16 nov, Q8). Las
 * letras son del colegio («COP», «CMP»), que va en su propio campo. Antes se admitían letras y
 * guion, y «abc» quedó como «COP abc» en un consentimiento firmado, que no se corrige.
 *
 * Es la regla de los colegios de Perú, que numeran a sus colegiados. Un país cuyo colegio use otro
 * formato la llevará en su perfil de país, junto al título y al colegio que ya propone.
 * La misma regla en la pantalla y en el servidor: una sola función.
 */
const REGISTRATION_NUMBER_RE = /^[0-9]{1,20}$/

/** Lo que se dice junto al campo cuando el número no es válido. */
export const REGISTRATION_NUMBER_WORDS =
  "El número de colegiatura lleva solo números, sin letras, espacios ni guiones. Las siglas del colegio van en «Colegio»."

export function isRegistrationNumber(value: string): boolean {
  return REGISTRATION_NUMBER_RE.test(value)
}
