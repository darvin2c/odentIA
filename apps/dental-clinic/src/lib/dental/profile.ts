import { type DentalCountryProfile, dentalProfileFor } from "@odentia/dental"
import { useOrgProfile } from "@odentia/clinic-app/lib/org"

/**
 * Lo dental del país de esta clínica (ADR 0079): odontograma oficial,
 * especialidades y título profesional. Mientras carga, o sin país, el núcleo.
 */
export function useDentalProfile(): DentalCountryProfile {
  return dentalProfileFor(useOrgProfile().data?.countryCode)
}
