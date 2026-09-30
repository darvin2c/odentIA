import type { Db } from "@odentia/db"
import { and, eq } from "drizzle-orm"
import { crmNote } from "@odentia/db/schema/crm-workspace"
import { createContactNote } from "./crm-workspace.js"

export interface SeedCrmActivityInput {
  orgId: string
  ownerUserId: string
  contactId: string
  conversationId?: string | null
  opportunityId?: string | null
}

/**
 * Notas operativas deterministas e idempotentes para desarrollo: dos notas
 * de trabajo sobre el contacto semilla (una general, una vinculada al hilo
 * y oportunidad si se indican). Si el contacto ya tiene notas, no crea.
 * El autor debe existir como usuario (FK); en seed-dev es el owner.
 */
export async function seedCrmActivity(tx: Db, input: SeedCrmActivityInput): Promise<void> {
  const { orgId, ownerUserId, contactId, conversationId, opportunityId } = input
  const existing = await tx
    .select({ id: crmNote.id })
    .from(crmNote)
    .where(and(eq(crmNote.organizationId, orgId), eq(crmNote.contactId, contactId)))
    .limit(1)
  if (existing.length > 0) return
  const actor = { userId: ownerUserId }
  await createContactNote(
    tx,
    orgId,
    contactId,
    {
      body: "Interesado en ortodoncia; prefiere contacto por la tarde.",
      conversationId: conversationId ?? null,
      opportunityId: opportunityId ?? null,
    },
    actor,
  )
  await createContactNote(
    tx,
    orgId,
    contactId,
    { body: "Se envió información del tratamiento; pendiente respuesta." },
    actor,
  )
}
