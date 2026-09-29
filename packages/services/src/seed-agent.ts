import type { Db } from "@odentia/db"
import { agentKnowledgeEntry, agentKnowledgeRevision, agentPolicy } from "@odentia/db/schema/agent"

/**
 * Seed del dominio IA: FAQs publicadas deterministas, una en borrador y la
 * política de autonomía por defecto. Idempotente por ids fijos.
 */
export async function seedAgent(
  tx: Db,
  input: { orgId: string; ownerUserId: string; branchId: string; patientId: string; contactId: string },
): Promise<void> {
  const { orgId, ownerUserId, branchId } = input
  const entries = [
    {
      id: "00000000-0000-4000-8000-00000000a601",
      kind: "faq",
      title: "¿Atienden sin cita?",
      body: "Sí, atendemos urgencias sin cita según disponibilidad del día. Para el resto de tratamientos pide tu cita por este chat o en recepción.",
      branchId: null as string | null,
      status: "publicada",
    },
    {
      id: "00000000-0000-4000-8000-00000000a602",
      kind: "faq",
      title: "¿Qué medios de pago aceptan?",
      body: "Aceptamos efectivo, tarjeta, transferencia, Yape y Plin. El detalle de tu tratamiento y su tarifa se confirman en la clínica antes de atenderte.",
      branchId: null,
      status: "publicada",
    },
    {
      id: "00000000-0000-4000-8000-00000000a603",
      kind: "info_sede",
      title: "Horario de atención",
      body: "Coordinar el horario exacto con la sede antes de publicarlo.",
      branchId,
      status: "borrador",
    },
  ]
  for (const entry of entries) {
    await tx
      .insert(agentKnowledgeEntry)
      .values({
        id: entry.id,
        organizationId: orgId,
        kind: entry.kind,
        title: entry.title,
        body: entry.body,
        branchId: entry.branchId,
        status: entry.status,
        version: 1,
        createdBy: ownerUserId,
      })
      .onConflictDoNothing({ target: agentKnowledgeEntry.id })
    await tx
      .insert(agentKnowledgeRevision)
      .values({
        organizationId: orgId,
        entryId: entry.id,
        version: 1,
        title: entry.title,
        body: entry.body,
        createdBy: ownerUserId,
      })
      .onConflictDoNothing({ target: [agentKnowledgeRevision.entryId, agentKnowledgeRevision.version] })
  }
  await tx
    .insert(agentPolicy)
    .values({ organizationId: orgId, modes: {}, updatedBy: ownerUserId })
    .onConflictDoNothing({ target: agentPolicy.organizationId })
}
