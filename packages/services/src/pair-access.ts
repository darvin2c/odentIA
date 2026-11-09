import type { Db } from "@odentia/db"
import { appointment, appointmentBookingLink } from "@odentia/db/schema/agenda"
import { automationLinkToken } from "@odentia/db/schema/automation"
import { portalGrant } from "@odentia/db/schema/portal-access"
import { and, eq, gt, inArray, isNull } from "drizzle-orm"
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
  // Los botones del correo de su cita llevan a su enlace: también dejan de servir (S4).
  await expireEmailAppointmentTokens(tx, orgId, input)
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

/**
 * Vence los tokens de «confirmar» y «cancelar» de los correos de las citas de un paciente
 * (de quien sea, o solo los de `contactId`): llevan a su enlace (`personalLinkForEmailToken`),
 * así que al quitarlo o terminar el vínculo dejan de servir. La baja nunca se toca.
 */
export async function expireEmailAppointmentTokens(
  tx: Db,
  orgId: string,
  input: { patientId: string; contactId?: string },
): Promise<void> {
  const now = new Date()
  await tx
    .update(automationLinkToken)
    .set({ expiresAt: now })
    .where(
      and(
        eq(automationLinkToken.organizationId, orgId),
        inArray(automationLinkToken.purpose, ["confirm", "cancel"]),
        gt(automationLinkToken.expiresAt, now),
        input.contactId ? eq(automationLinkToken.contactId, input.contactId) : undefined,
        inArray(
          automationLinkToken.appointmentId,
          tx
            .select({ id: appointment.id })
            .from(appointment)
            .where(
              and(eq(appointment.organizationId, orgId), eq(appointment.patientId, input.patientId)),
            ),
        ),
      ),
    )
}
