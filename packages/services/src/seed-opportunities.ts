import type { Db } from "@odentia/db"
import { ensureDefaultPipeline } from "./pipelines.js"
import { requireContact } from "./contacts.js"
import { createOpportunity, listOpportunities, updateOpportunity } from "./opportunities.js"

export interface SeedOpportunitiesInput {
  orgId: string
  ownerUserId: string
  branchId: string
  patientId: string
  contactId: string
  conversationId?: string
}

/**
 * Oportunidades deterministas e idempotentes: dos por el contacto semilla
 * (una abierta con próxima acción, una en segunda etapa con valor), atadas
 * al paciente semilla y al hilo origen. Concilia la misma demostración.
 */
export async function seedOpportunities(
  tx: Db,
  input: SeedOpportunitiesInput,
): Promise<void> {
  const { orgId, ownerUserId, patientId, contactId, conversationId } = input
  await requireContact(tx, orgId, contactId)
  const { stages } = await ensureDefaultPipeline(tx, orgId)
  const open = stages.filter((s) => s.kind === "open")
  if (open.length === 0) throw new Error("Pipeline default sin etapas abiertas")
  const existing = await listOpportunities(tx, orgId, { contactId, q: "Ortodoncia · evaluación inicial", limit: 1 })
  const first = open[0]!
  const second = open[1] ?? first
  const actor = { userId: ownerUserId }
  const firstInput = {
    contactId, patientId, stageId: first.id, title: "Ortodoncia · evaluación inicial",
    interestText: "Ortodoncia", amountCents: 250000, currency: "PEN",
    assignedUserId: ownerUserId, nextActionAt: "2026-10-05T15:00:00.000Z",
    nextActionNote: "Llamar para confirmar evaluación", conversationId: conversationId ?? null,
  }
  if (existing.items[0]) {
    await updateOpportunity(tx, orgId, existing.items[0].id, firstInput, actor)
    return
  }
  await createOpportunity(
    tx,
    orgId,
    firstInput,
    actor,
  )
  await createOpportunity(
    tx,
    orgId,
    {
      contactId,
      stageId: second.id,
      conversationId: conversationId ?? null,
      title: "Limpieza · control semestral",
      interestText: "Profilaxis",
      amountCents: 15000,
      currency: "PEN",
    },
    actor,
  )
}
