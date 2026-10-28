import { normalizeCountryCode } from "@odentia/clinical"

/**
 * El título y el colegio que se proponen al médico al completar su perfil
 * profesional, a la vista y editables. Solo en Perú: «Médico cirujano» y el
 * Colegio Médico del Perú (CMP), como el odontólogo con el COP
 * (`dentalProfileFor`). En otro país no se propone nada.
 */
const BY_COUNTRY: Record<string, { title: string; registrationBody: string }> = {
  PE: { title: "Médico cirujano", registrationBody: "CMP" },
}

export function medicalProfessionalFor(
  country: string | null | undefined,
): { title: string; registrationBody: string } | null {
  const code = normalizeCountryCode(country)
  return (code && BY_COUNTRY[code]) || null
}
