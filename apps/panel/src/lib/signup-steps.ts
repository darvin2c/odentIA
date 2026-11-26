/**
 * Los pasos del alta de la clínica (`onboarding`): la barra y «Paso N de 3» cuentan estos mismos.
 * La cuenta (registro y su confirmación) va antes y no se numera, para que ninguna pantalla diga
 * un número distinto de otra.
 */
export const SIGNUP_CLINIC_STEPS = [
  { id: "org", label: "Clínica" },
  { id: "profile", label: "Datos" },
  { id: "branch", label: "Sede" },
] as const
