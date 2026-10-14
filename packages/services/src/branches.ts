import type { Db } from "@odentia/db"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { ServiceError } from "./errors.js"

/**
 * Desactiva o reactiva una sede. Desactivarla la saca de la agenda, de las
 * reservas y de lo que responde el agente; no borra nada: sus citas, horarios
 * y sillones se conservan y vuelven tal cual al reactivarla. Repetir el mismo
 * estado no cambia nada ni deja otra entrada de auditoría.
 */
export async function setBranchActive(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  isActive: boolean,
): Promise<{ id: string; isActive: boolean }> {
  const [current] = await tx
    .select({ id: branch.id, isActive: branch.isActive })
    .from(branch)
    .where(and(eq(branch.id, id), eq(branch.organizationId, orgId)))
    .limit(1)
    .for("update")
  if (!current) throw new ServiceError("NOT_FOUND", 404, "Sede no encontrada")
  if (current.isActive === isActive) return current
  await tx
    .update(branch)
    .set({ isActive, updatedAt: new Date() })
    .where(and(eq(branch.id, id), eq(branch.organizationId, orgId)))
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: isActive ? "branch.reactivate" : "branch.deactivate",
    entity: "branch",
    entityId: id,
  })
  return { id, isActive }
}
