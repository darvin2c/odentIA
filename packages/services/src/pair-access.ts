import type { Db } from "@odentia/db"
import { appointmentBookingLink } from "@odentia/db/schema/agenda"
import { portalGrant } from "@odentia/db/schema/portal-access"
import { and, eq, isNull } from "drizzle-orm"
import { revokePortalGrant } from "./portal-access.js"

/**
 * Lo que una persona tenía para un paciente deja de servir cuando cambia lo
 * que es para él (se revoca su representación, se le desvincula o cambia su
 * vínculo): «Su enlace» y el acceso al portal de ese par, con sus sesiones,
 * llaves y enlaces. Lo que el par siga pudiendo hacer se vuelve a dar.
 */
export async function endPairAccess(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { patientId: string; contactId: string; reason: string },
): Promise<void> {
  await tx
    .update(appointmentBookingLink)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(appointmentBookingLink.organizationId, orgId),
        eq(appointmentBookingLink.patientId, input.patientId),
        eq(appointmentBookingLink.contactId, input.contactId),
        isNull(appointmentBookingLink.revokedAt),
      ),
    )
  const grants = await tx
    .select({ id: portalGrant.id })
    .from(portalGrant)
    .where(
      and(
        eq(portalGrant.organizationId, orgId),
        eq(portalGrant.patientId, input.patientId),
        eq(portalGrant.contactId, input.contactId),
        eq(portalGrant.status, "activo"),
      ),
    )
  for (const grant of grants) await revokePortalGrant(tx, orgId, actorUserId, grant.id, input.reason)
}
