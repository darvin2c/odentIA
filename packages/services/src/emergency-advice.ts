import { emergencyAdvice, emergencyNumberFor, urgentClinicPhone } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"

/**
 * A dónde llamar, para el aviso fijo del agente (ADR 0084). Ante una señal de
 * alarma (`alarma`), el número de emergencias del país de la clínica y su
 * teléfono para urgencias; ante una urgencia sin peligro para la vida
 * (`urgente`), solo ese teléfono, o nada si la clínica no lo registró.
 */
export async function emergencyAdviceFor(
  tx: Db,
  orgId: string,
  treatment: "tu" | "usted" | null = null,
  level: "alarma" | "urgente" = "alarma",
): Promise<string | null> {
  const [row] = await tx
    .select({ country: orgProfile.countryCode, phone: orgProfile.emergencyPhone })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  const phone = row?.phone ?? null
  return level === "alarma" ? emergencyAdvice(emergencyNumberFor(row?.country), phone, treatment) : urgentClinicPhone(phone, treatment)
}
