import type { Db } from "@odentia/db"
import { createWorkspaceNotification } from "./workspace.js"

export async function seedWorkspace(tx: Db, input: { orgId: string; ownerUserId: string; branchId: string; patientId: string; contactId: string }) {
  await createWorkspaceNotification(tx, input.orgId, {
    userId: input.ownerUserId,
    dedupeKey: "seed:workspace:review",
    title: "Revisa la jornada de la clínica",
    body: "El inicio reúne citas, conversaciones y pendientes del equipo.",
    href: "/home",
    permission: "tasks.read",
  })
}
