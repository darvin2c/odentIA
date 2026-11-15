import { ageFrom } from "@odentia/clinic-app/lib/patients"

/** Dentición que corresponde mostrar por edad; el clínico puede cambiarla. */
export type Dentition = "adult" | "mixed" | "primary"

/**
 * Recambio dentario habitual: temporal hasta los 5 años, mixta de 6 a 12 y
 * permanente desde los 13. Sin fecha de nacimiento no se supone una edad.
 */
export function suggestedDentition(
  birthDate: string | null | undefined,
  today?: string,
): Dentition | null {
  // Con el día de la clínica (`ageFrom`): leída como medianoche UTC, la edad subía un día antes en Lima.
  const years = ageFrom(birthDate, today)
  if (!years) return null
  const age = Number(years)
  if (age <= 5) return "primary"
  if (age <= 12) return "mixed"
  return "adult"
}
