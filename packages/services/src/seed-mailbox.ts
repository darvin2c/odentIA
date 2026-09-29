// Seed de buzones: una conexión Gmail ejemplo DESACTIVADA y sin credenciales
// reales (config no descifrable a propósito). El flujo OAuth la reemplaza.
// No importar en tests ni en el barrel de servicios: el padre la conecta a
// seed-dev. Purge: la fila vive en channel_connection (purge de ese dueño);
// mailbox_oauth_state no se sella (solo runtime, TTL 10 min).
import type { Db } from "@odentia/db"
import { channelConnection } from "@odentia/db/schema/crm"
import { and, eq } from "drizzle-orm"

export async function seedMailbox(
  tx: Db,
  input: { orgId: string; ownerUserId: string; branchId: string; patientId: string; contactId: string },
): Promise<void> {
  const displayName = "Buzón ejemplo (sin conectar)"
  const [existing] = await tx
    .select({ id: channelConnection.id })
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.organizationId, input.orgId),
        eq(channelConnection.channel, "email"),
        eq(channelConnection.displayName, displayName),
      ),
    )
    .limit(1)
  if (existing) return
  await tx.insert(channelConnection).values({
    organizationId: input.orgId,
    channel: "email",
    provider: "gmail",
    displayName,
    externalId: null,
    // Marcador no descifrable: conectar por OAuth lo reemplaza. Nunca habilitar
    // esta fila sin pasar por completeMailboxOAuth.
    configEncrypted: "pendiente-oauth",
    webhookSecret: "pendiente-oauth",
    status: "disabled",
  })
}
