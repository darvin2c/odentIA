import type { Db } from "@odentia/db"
import { ensureDefaultPipeline } from "./pipelines.js"
import { requireContact } from "./contacts.js"
import { createOpportunity, listOpportunities } from "./opportunities.js"

export interface SeedOpportunitiesInput {
  orgId: string
  ownerUserId: string
  branchId: string
  patientId: string
  contactId: string
}

/**
 * Oportunidades deterministas e idempotentes: dos por el contacto semilla
 * (una abierta con próxima acción, una en segunda etapa con valor), atadas
 * al paciente semilla. Si ya existen oportunidades del contacto, no crea.
 */
export async function seedOpportunities(
  tx: Db,
  input: SeedOpportunitiesInput,
): Promise<void> {
  const { orgId, ownerUserId, patientId, contactId } = input
  await requireContact(tx, orgId, contactId)
  const { stages } = await ensureDefaultPipeline(tx, orgId)
  const open = stages.filter((s) => s.kind === "open")
  if (open.length === 0) throw new Error("Pipeline default sin etapas abiertas")
  const existing = await listOpportunities(tx, orgId, { contactId, limit: 1 })
  if (existing.items.length > 0) return
  const first = open[0]!
  const second = open[1] ?? first
  const actor = { userId: ownerUserId }
  await createOpportunity(
    tx,
    orgId,
    {
      contactId,
      patientId,
      stageId: first.id,
      title: "Ortodoncia · evaluación inicial",
      interestText: "Ortodoncia",
      amountCents: 250000,
      currency: "PEN",
      assignedUserId: ownerUserId,
      nextActionAt: new Date("2026-10-05T15:00:00.000Z").toISOString(),
      nextActionNote: "Llamar para confirmar evaluación",
    },
    actor,
  )
  await createOpportunity(
    tx,
    orgId,
    {
      contactId,
      stageId: second.id,
      title: "Limpieza · control semestral",
      interestText: "Profilaxis",
      amountCents: 15000,
      currency: "PEN",
    },
    actor,
  )
}
