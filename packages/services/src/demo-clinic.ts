import type { Db } from "@odentia/db"
import { saasSubscription } from "@odentia/db/schema/saas-billing"
import { eq } from "drizzle-orm"

/**
 * Si es una clínica de demostración (su suscripción lo dice, ADR 0096): sus
 * canales no tienen un número ni una cuenta de verdad, y lo que muestran sus
 * conversaciones es de ejemplo. Las pantallas lo dicen así en vez de un
 * «Desconectado» a secas.
 */
export async function isDemoClinic(tx: Db, orgId: string): Promise<boolean> {
  const [row] = await tx
    .select({ isDemo: saasSubscription.isDemo })
    .from(saasSubscription)
    .where(eq(saasSubscription.organizationId, orgId))
    .limit(1)
  return row?.isDemo === true
}
