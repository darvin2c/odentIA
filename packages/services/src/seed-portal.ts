import { createHash, randomBytes } from "node:crypto"
import type { Db } from "@odentia/db"
import { portalAccessLog, portalLink, portalSession } from "@odentia/db/schema/portal"
import { and, eq } from "drizzle-orm"

/**
 * Seed del portal: enlaces de muestra SIN tokens permanentes publicados.
 * Los tokens crudos son aleatorios y se descartan tras insertar solo su hash;
 * los enlaces quedan revocados/vencidos/usados para probar esos caminos en
 * la UI staff. Idempotente: limpia las filas del paciente y las recrea.
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

  const sessionRows = await tx
    .select({ id: portalSession.id })
    .from(portalSession)
    .where(and(eq(portalSession.organizationId, orgId), eq(portalSession.patientId, patientId)))
  for (const row of sessionRows) {
    await tx.delete(portalAccessLog).where(eq(portalAccessLog.sessionId, row.id))
  }
  await tx
    .delete(portalSession)
    .where(and(eq(portalSession.organizationId, orgId), eq(portalSession.patientId, patientId)))
  await tx
    .delete(portalLink)
    .where(and(eq(portalLink.organizationId, orgId), eq(portalLink.patientId, patientId)))

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
}
