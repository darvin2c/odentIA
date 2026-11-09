import { normalizeCountryCode } from "@odentia/clinical"

/**
 * El título y el colegio que se proponen al optómetra al completar su perfil
 * profesional, a la vista y editables. Solo en Perú: el optómetra es tecnólogo
 * médico en optometría y se colegia en el Colegio Tecnólogo Médico del Perú
 * (CTMP), como el odontólogo con el COP y el médico con el CMP. En otro país no
 * se propone nada.
 */
const BY_COUNTRY: Record<string, { title: string; registrationBody: string }> = {
  PE: { title: "Tecnólogo médico en optometría", registrationBody: "CTMP" },
}

export function opticalProfessionalFor(
  country: string | null | undefined,
): { title: string; registrationBody: string } | null {
  const code = normalizeCountryCode(country)
  return (code && BY_COUNTRY[code]) || null
}
