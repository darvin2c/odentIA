/**
 * La cuenta de pasos de quien abre su clínica, la misma de principio a fin:
 * crear la cuenta (1), confirmarla —el correo o, con Google, los documentos—
 * (2) y el alta de la clínica (3 a 5). Registro, «Revisa tu correo»,
 * documentos y alta leen el número de aquí para no contar cada uno a su modo.
 */
export const SIGNUP_ACCOUNT_STEPS = [
  { id: "cuenta", label: "Tu cuenta" },
  { id: "confirmar", label: "Confirmación" },
] as const

/** Los pasos del alta de la clínica (`onboarding`), después de los de la cuenta. */
export const SIGNUP_CLINIC_STEPS = [
  { id: "org", label: "Organización" },
  { id: "profile", label: "Perfil legal" },
  { id: "branch", label: "Sede" },
] as const

export const SIGNUP_STEP_TOTAL = SIGNUP_ACCOUNT_STEPS.length + SIGNUP_CLINIC_STEPS.length

/** «1 de 5»: la insignia de cada pantalla de la cuenta. */
export function signupStepOf(position: number): string {
  return `${position} de ${SIGNUP_STEP_TOTAL}`
}
