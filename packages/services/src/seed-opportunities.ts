import type { Db } from "@odentia/db"
import { requireContact } from "./contacts.js"
import { createOpportunity, listOpportunities, moveOpportunity, setOpportunityTask } from "./opportunities.js"
import { ensureDefaultPipeline } from "./pipelines.js"

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
 * (una en «Interesado» con su tarea, otra en «Evaluación agendada» con valor),
 * atadas al paciente semilla y al hilo origen. Concilia la misma demostración.
 */
export async function seedOpportunities(
  tx: Db,
  input: SeedOpportunitiesInput,
): Promise<void> {
  const { orgId, ownerUserId, patientId, contactId, conversationId } = input
  await requireContact(tx, orgId, contactId)
  const { stages } = await ensureDefaultPipeline(tx, orgId)
  const evaluation = stages.find((stage) => stage.moment === "evaluacion_agendada")
  if (!evaluation) throw new Error("El embudo no tiene el paso «Evaluación agendada»")
  const existing = await listOpportunities(tx, orgId, { contactId, q: "Ortodoncia · evaluación inicial", limit: 1 })
  if (existing.items[0]) return
  const actor = { userId: ownerUserId }
  const first = await createOpportunity(
    tx,
    orgId,
    {
      contactId,
      patientId,
      title: "Ortodoncia · evaluación inicial",
      interestText: "Ortodoncia",
      amountCents: 250000,
      assignedUserId: ownerUserId,
      conversationId: conversationId ?? null,
    },
    actor,
  )
  await setOpportunityTask(
    tx,
    orgId,
    first.id,
    { title: "Llamar para confirmar la evaluación", dueAt: "2026-10-05T15:00:00.000Z" },
    { userId: ownerUserId, createdBy: "user" },
  )
  const second = await createOpportunity(
    tx,
    orgId,
    {
      contactId,
      conversationId: conversationId ?? null,
      title: "Limpieza · control semestral",
      interestText: "Profilaxis",
      amountCents: 15000,
    },
    actor,
  )
  await moveOpportunity(tx, orgId, second.id, evaluation.id, actor)
}
