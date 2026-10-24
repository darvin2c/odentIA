/**
 * El número para pedir una ambulancia ante una emergencia, por país (ISO 3166-1
 * alfa-2). Sofi lo dice solo cuando la vida puede estar en peligro y va en el
 * aviso fijo cuando el mensaje trae una señal de alarma (ADR 0084). Fuentes,
 * consultadas el 2026-10-23:
 *
 * - AR 911: argentina.gob.ar/tema/emergencias («si necesitás pedir una
 *   ambulancia»); el 107 (SAME) solo cubre la Ciudad y parte de la provincia
 *   de Buenos Aires.
 * - CL 131: minsal.cl, SAMU.
 * - CO 123: línea única de emergencias.
 * - CR 911: sistema 9-1-1, que despacha a la Cruz Roja.
 * - EC 911: ECU 911.
 * - MX 911: número único de emergencias (IFT, DOF).
 * - PE 106: SAMU del Minsa.
 * - SV 132: Sistema de Emergencias Médicas (el 911 es de la policía).
 *
 * Un país sin número comprobado no tiene uno: se dice «la emergencia más
 * cercana». Nunca se inventa.
 */
const EMERGENCY_NUMBERS: Readonly<Record<string, string>> = {
  AR: "911",
  CL: "131",
  CO: "123",
  CR: "911",
  EC: "911",
  MX: "911",
  PE: "106",
  SV: "132",
}

/** El número de emergencias médicas del país, o null si no hay uno comprobado. */
export function emergencyNumberFor(country: string | null | undefined): string | null {
  return country ? (EMERGENCY_NUMBERS[country.toUpperCase()] ?? null) : null
}

/**
 * Qué hacer ante una emergencia, en una frase con el número del país y el
 * teléfono para urgencias de la clínica si lo registró. La dicen el aviso fijo
 * y lo que Sofi sabe de la clínica: el mismo texto en los dos lados.
 */
export function emergencyAdvice(
  number: string | null,
  clinicPhone: string | null,
  treatment: "tu" | "usted" | null = null,
): string {
  const usted = treatment === "usted"
  const go = number
    ? usted
      ? `llame ahora al ${number} o vaya a la emergencia más cercana`
      : `llama ahora al ${number} o ve a la emergencia más cercana`
    : usted
      ? "vaya ahora a la emergencia más cercana"
      : "ve ahora a la emergencia más cercana"
  const clinic = clinicPhone
    ? usted
      ? ` También puede llamar a la clínica al ${clinicPhone}.`
      : ` También puedes llamar a la clínica al ${clinicPhone}.`
    : ""
  return `Si es una emergencia, ${go}.${clinic}`
}

/**
 * Ante una urgencia sin peligro para la vida (un dolor fuerte, un golpe, una
 * hinchazón), el teléfono para urgencias de la clínica si lo registró: mandar a
 * llamar a una ambulancia por un dolor de muela asusta y no ayuda (ADR 0084).
 */
export function urgentClinicPhone(clinicPhone: string | null, treatment: "tu" | "usted" | null = null): string | null {
  if (!clinicPhone) return null
  return treatment === "usted"
    ? `Si es urgente, puede llamar a la clínica al ${clinicPhone}.`
    : `Si es urgente, puedes llamar a la clínica al ${clinicPhone}.`
}
