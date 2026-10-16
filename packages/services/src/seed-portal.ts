import { createHash, randomBytes } from "node:crypto"
import type { Db } from "@odentia/db"
import { portalAccessLog, portalLink, portalSession } from "@odentia/db/schema/portal"
import {
  portalGrant,
  portalPasskey,
  portalPolicy,
  portalVerification,
} from "@odentia/db/schema/portal-access"
import { and, eq, inArray } from "drizzle-orm"

/**
 * Seed del portal: política demo habilitada, grant verificado y enlaces de
 * muestra SIN tokens permanentes publicados. Los tokens crudos son aleatorios
 * y se descartan tras insertar solo su hash; los enlaces quedan
 * revocados/vencidos/usados para probar esos caminos en la UI staff.
 * Idempotente: limpia las filas del paciente y las recrea.
 */
export async function seedPortal(
  tx: Db,
  input: { orgId: string; ownerUserId: string; branchId: string; patientId: string; contactId: string },
): Promise<void> {
  const { orgId, ownerUserId, patientId, contactId } = input
  const linkScope = { appointments: true, budgets: true, account: true, documents: [] as string[] }
  const discard = () => createHash("sha256").update(randomBytes(32)).digest("hex")
  const past = new Date(Date.now() - 24 * 3600_000)
  const future = new Date(Date.now() + 72 * 3600_000)

  await tx
    .insert(portalPolicy)
    .values({
      organizationId: orgId,
      portalEnabled: true,
      allowedScope: { appointments: true, budgets: true, account: true, documents: true },
      updatedBy: ownerUserId,
    })
    .onConflictDoUpdate({
      target: portalPolicy.organizationId,
      set: { portalEnabled: true, updatedBy: ownerUserId, updatedAt: new Date() },
    })

  const pairGrants = await tx
    .select({ id: portalGrant.id })
    .from(portalGrant)
    .where(
      and(
        eq(portalGrant.organizationId, orgId),
        eq(portalGrant.patientId, patientId),
        eq(portalGrant.contactId, contactId),
      ),
    )
  const grantIds = pairGrants.map((row) => row.id)
  const staleSessions =
    grantIds.length === 0
      ? []
      : await tx
          .select({ id: portalSession.id })
          .from(portalSession)
          .where(and(eq(portalSession.organizationId, orgId), inArray(portalSession.grantId, grantIds)))
  const patientSessions = await tx
    .select({ id: portalSession.id })
    .from(portalSession)
    .where(and(eq(portalSession.organizationId, orgId), eq(portalSession.patientId, patientId)))
  for (const row of [...staleSessions, ...patientSessions]) {
    await tx.delete(portalAccessLog).where(eq(portalAccessLog.sessionId, row.id))
  }
  await tx
    .delete(portalSession)
    .where(and(eq(portalSession.organizationId, orgId), eq(portalSession.patientId, patientId)))
  if (grantIds.length > 0) {
    await tx
      .delete(portalPasskey)
      .where(and(eq(portalPasskey.organizationId, orgId), inArray(portalPasskey.grantId, grantIds)))
  }
  await tx
    .delete(portalVerification)
    .where(and(eq(portalVerification.organizationId, orgId), eq(portalVerification.patientId, patientId)))
  await tx
    .delete(portalGrant)
    .where(and(eq(portalGrant.organizationId, orgId), eq(portalGrant.patientId, patientId)))
  await tx
    .delete(portalLink)
    .where(and(eq(portalLink.organizationId, orgId), eq(portalLink.patientId, patientId)))

  const [grant] = await tx
    .insert(portalGrant)
    .values({
      organizationId: orgId,
      patientId,
      contactId,
      scope: linkScope,
      status: "activo",
      verifiedMethod: "representacion_verificada",
      verifiedBy: ownerUserId,
      verifiedAt: past,
      createdBy: ownerUserId,
    })
    .returning()
  if (!grant) throw new Error("No se pudo sembrar el grant del portal")
  await tx.insert(portalVerification).values({
    organizationId: orgId,
    patientId,
    contactId,
    grantId: grant.id,
    method: "representacion_verificada",
    verifiedBy: ownerUserId,
    evidenceNote: "Seed demo: verificación del representante en recepción.",
  })

  const [revoked] = await tx
    .insert(portalLink)
    .values({
      organizationId: orgId,
      patientId,
      contactId,
      scope: linkScope,
      tokenHash: discard(),
      status: "revocado",
      expiresAt: future,
      revokedAt: past,
      revokedBy: ownerUserId,
      idempotencyKey: "seed-portal-revocado",
      createdBy: ownerUserId,
    })
    .returning()
  const [expired] = await tx
    .insert(portalLink)
    .values({
      organizationId: orgId,
      patientId,
      contactId,
      scope: linkScope,
      tokenHash: discard(),
      status: "pendiente",
      expiresAt: past,
      idempotencyKey: "seed-portal-vencido",
      createdBy: ownerUserId,
    })
    .returning()
  const [used] = await tx
    .insert(portalLink)
    .values({
      organizationId: orgId,
      patientId,
      contactId,
      scope: linkScope,
      tokenHash: discard(),
      status: "usado",
      expiresAt: future,
      usedAt: past,
      idempotencyKey: "seed-portal-usado",
      createdBy: ownerUserId,
    })
    .returning()
  if (!revoked || !expired || !used) throw new Error("No se pudo sembrar el portal")
  const [session] = await tx
    .insert(portalSession)
    .values({
      organizationId: orgId,
      patientId,
      contactId,
      linkId: used.id,
      grantId: grant.id,
      authMethod: "enlace_pin",
      scope: linkScope,
      tokenHash: discard(),
      expiresAt: future,
      revokedAt: past,
      revokedBy: ownerUserId,
      issuedBy: ownerUserId,
      lastSeenAt: past,
    })
    .returning()
  if (!session) throw new Error("No se pudo sembrar la sesión del portal")
  await tx.insert(portalAccessLog).values([
    {
      organizationId: orgId,
      sessionId: session.id,
      action: "session.opened",
      metadata: { seed: true },
    },
    {
      organizationId: orgId,
      sessionId: session.id,
      action: "appointments.listed",
      metadata: { seed: true },
    },
  ])
  const seedCredentialId = createHash("sha256")
    .update(`seed-passkey:${orgId}:${patientId}:${contactId}`, "utf8")
    .digest("base64url")
  await tx.insert(portalPasskey).values({
    organizationId: orgId,
    grantId: grant.id,
    credentialId: seedCredentialId,
    publicKey: createHash("sha256").update(`seed-pub:${seedCredentialId}`, "utf8").digest("base64url"),
    counter: 0,
    transports: ["internal"],
    nickname: "Seed demo (revocada)",
    createdAt: past,
    revokedAt: past,
    revokedBy: ownerUserId,
  })
}
