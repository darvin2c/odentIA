import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { accountRecoveryCase } from "@odentia/db/schema/admin-organizations"
import { invitation } from "@odentia/db/schema/auth"
import { and, eq } from "drizzle-orm"

/**
 * Semilla dev de organizaciones y cuentas: inserciones idempotentes con
 * correos @odentia.dev claramente ficticios; nunca envía correos ni activa
 * automatizaciones. Requiere el staff interno 'seed-staff-support' ya creado.
 *
 * - Una invitación pendiente de recepción en la clínica semilla, para ver el
 *   flujo invitar → aceptar → reanudar alta en el panel y en el admin.
 * - Un caso de recuperación de acceso pendiente con evidencia verificada de
 *   ejemplo, para la pantalla de usuarios del admin.
 */
export async function seedAdminOrganizations(db: Db): Promise<void> {
  const orgId = "seed-org-dental-smile"
  const inviterId = "seed-staff-support"

  const existingInvite = await db
    .select({ id: invitation.id })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, orgId),
        eq(invitation.email, "invitada.demo@odentia.dev"),
        eq(invitation.status, "pending"),
      ),
    )
    .limit(1)
  if (existingInvite.length === 0) {
    await db.insert(invitation).values({
      id: randomUUID(),
      organizationId: orgId,
      email: "invitada.demo@odentia.dev",
      role: "reception",
      status: "pending",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      inviterId,
    })
  }

  const existingCase = await db
    .select({ id: accountRecoveryCase.id })
    .from(accountRecoveryCase)
    .where(
      and(
        eq(accountRecoveryCase.email, "recupero.demo@odentia.dev"),
        eq(accountRecoveryCase.status, "pendiente"),
      ),
    )
    .limit(1)
  if (existingCase.length === 0) {
    await db.insert(accountRecoveryCase).values({
      email: "recupero.demo@odentia.dev",
      kind: "acceso",
      status: "pendiente",
      evidence: {
        description:
          "Llamó por teléfono y dictó su documento; se validó contra la ficha de personal de la clínica semilla.",
        verifiedBy: inviterId,
        verifiedAt: new Date().toISOString(),
        method: "Verificación por llamada al número registrado de la clínica + documento dictado",
      },
      requestedBy: inviterId,
      approvals: [],
    })
  }
}
