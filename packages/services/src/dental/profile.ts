import { type DentalCountryProfile, dentalProfileFor } from "@odentia/dental"
import type { Db } from "@odentia/db"
import { findOrgCountry } from "../locale.js"

/**
 * Lo dental del país de la clínica (ADR 0079): odontograma oficial,
 * especialidades y título profesional. Lo común del país es `orgClinicalProfile`.
 */
export async function orgDentalProfile(tx: Db, orgId: string): Promise<DentalCountryProfile> {
  return dentalProfileFor(await findOrgCountry(tx, orgId))
}
