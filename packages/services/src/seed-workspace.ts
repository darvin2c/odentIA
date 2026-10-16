import type { Db } from "@odentia/db"
import { createWorkspaceNotification } from "./workspace.js"

/**
 * Avisos de ejemplo para la campana: solo lo que no pide trabajo (lo que pide
 * trabajo está en «Te espera»). Uno ya leído, para ver los dos estados.
 */
export async function seedWorkspace(tx: Db, input: { orgId: string; ownerUserId: string; branchId: string; patientId: string; contactId: string }) {
  await createWorkspaceNotification(tx, input.orgId, {
    userId: input.ownerUserId,
    dedupeKey: "seed:workspace:consentimiento",
    title: "Un consentimiento fue firmado",
    body: "Un consentimiento que generaste ya tiene firma registrada.",
    href: `/patients/${input.patientId}`,
    permission: "clinical.read",
  })
  await createWorkspaceNotification(tx, input.orgId, {
    userId: input.ownerUserId,
    dedupeKey: "seed:workspace:caja",
    title: "La caja cerró con diferencia",
    body: "El efectivo contado en la sede no coincidió con lo esperado.",
    href: "/finance",
    permission: "finance.read",
  })
}
