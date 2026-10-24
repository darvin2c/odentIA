/** Dentición que corresponde mostrar por edad; el clínico puede cambiarla. */
export type Dentition = "adult" | "mixed" | "primary"

/**
 * Recambio dentario habitual: temporal hasta los 5 años, mixta de 6 a 12 y
 * permanente desde los 13. Sin fecha de nacimiento no se supone una edad.
 */
export function suggestedDentition(
  birthDate: string | null | undefined,
  today = new Date(),
): Dentition | null {
  if (!birthDate) return null
  const born = new Date(birthDate)
  if (Number.isNaN(born.getTime())) return null
  let age = today.getFullYear() - born.getFullYear()
  const month = today.getMonth() - born.getMonth()
  if (month < 0 || (month === 0 && today.getDate() < born.getDate())) age -= 1
  if (age < 0) return null
  if (age <= 5) return "primary"
  if (age <= 12) return "mixed"
  return "adult"
}
