import { emergencyAdvice, emergencyNumberFor } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"

/**
 * Qué hacer ante una emergencia, con el número del país de la clínica y su
 * teléfono para urgencias (ADR 0084). Lo usa el aviso fijo del agente cuando
 * lo que escribió la persona es una posible emergencia.
 */
export async function emergencyAdviceFor(tx: Db, orgId: string, treatment: "tu" | "usted" | null = null): Promise<string> {
  const [row] = await tx
    .select({ country: orgProfile.countryCode, phone: orgProfile.emergencyPhone })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  return emergencyAdvice(emergencyNumberFor(row?.country), row?.phone ?? null, treatment)
}
