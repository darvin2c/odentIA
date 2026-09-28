import { call, expect, type OwnerFixture } from "./fixtures"

export type ClinicalIds = {
  contactId: string
  patientId: string
  serviceId: string
  encounterId: string
  planId: string
  findingId: string
  itemId: string
}

export type AcceptedBudget = { budgetId: string; budgetLineId: string }

export type AggregationIds = AcceptedBudget & {
  chargeId: string
  paymentId: string
  prescriptionId: string
  followUpId: string
}

export function patientApiPath(patientId: string): string {
  return `/api/patients/${patientId}`
}

/** Fecha calendario en America/Lima (la API exige fecha local, no UTC). */
function limaDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
}

/**
 * Bloque API de la ficha clínica: contacto tutor, paciente, salud, servicio de
 * 45000 PEN, atención finalizada, plan, hallazgo en pieza 36 (K02.1) e
 * indicación vinculada. La atención queda finalizada para los controles.
 */
export async function buildClinicalBase(owner: OwnerFixture): Promise<ClinicalIds> {
  const { page } = owner
  const slug = owner.org.slug
  const contact = await call<{ id: string }>(page, "POST", "/api/contacts", slug, {
    displayName: "Madre de Lucía",
  }, 201)
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", slug, {
    submissionId: crypto.randomUUID(),
    answers: {
      demographics: { displayName: "Lucía Quispe", docType: "DNI", docNumber: "87654321" },
      respondent: "staff",
      privacyAccepted: false,
    },
    contacts: [
      {
        contactId: contact.id,
        relationship: "guardian",
        relationshipDetail: "Madre",
        isPreferred: true,
      },
    ],
  }, 201)
  const apiPath = patientApiPath(patient.id)
  await call(page, "PUT", `${apiPath}/health`, slug, {
    expectedRevision: 0,
    reviewStatus: { allergies: "recorded", conditions: "none", medications: "none" },
    allergies: [{ substance: "Penicilina", severity: "severa" }],
    conditions: [],
    medications: [],
  })
  const service = await call<{ id: string }>(page, "POST", "/api/services", slug, {
    name: "Endodoncia unirradicular",
    specialty: "endodoncia",
    scope: "tooth",
    priceCents: 45000,
    currency: "PEN",
  }, 201)
  const encounter = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, slug, {
    reason: "Dolor molar inferior derecho",
  }, 201)
  const plan = await call<{ id: string }>(page, "POST", `${apiPath}/plans`, slug, {
    title: "Plan de Lucía",
    originEncounterId: encounter.id,
  }, 201)
  const finding = await call<Array<{ id: string }>>(page, "POST", `${apiPath}/odontogram/entries`, slug, {
    toothNumber: 36,
    condition: "caries",
    surfaces: ["occlusal"],
    details: { variant: "dentin" },
  }, 201)
  const findingId = finding[0]?.id
  expect(findingId, "odontogram.entries devuelve el hallazgo creado").toBeTruthy()
  // La indicación nace de un hallazgo real del odontograma.
  const item = await call<{ id: string }>(page, "POST", `${apiPath}/plan/items`, slug, {
    planId: plan.id,
    serviceId: service.id,
    sourceEncounterId: encounter.id,
    toothNumber: 36,
    odontogramEntryId: findingId,
    diagnosisCode: "K02.1",
  }, 201)
  await call(page, "PATCH", `${apiPath}/encounters/${encounter.id}`, slug, {
    evolution: "Se evalúa pieza 36 con caries oclusal; se indica endodoncia.",
  })
  await call(page, "POST", `${apiPath}/encounters/${encounter.id}/finalize`, slug, {})
  return {
    contactId: contact.id,
    patientId: patient.id,
    serviceId: service.id,
    encounterId: encounter.id,
    planId: plan.id,
    findingId: findingId as string,
    itemId: item.id,
  }
}

/** Presupuesto en borrador; la presentación y la decisión las hace cada caso. */
export async function createDraftBudget(
  owner: OwnerFixture,
  ids: ClinicalIds,
  title = "Propuesta de Lucía",
): Promise<{ budgetId: string }> {
  const budget = await call<{ id: string }>(
    owner.page,
    "POST",
    `${patientApiPath(ids.patientId)}/budgets`,
    owner.org.slug,
    { planId: ids.planId, itemIds: [ids.itemId], title },
    201,
  )
  return { budgetId: budget.id }
}

/**
 * Presupuesto presentado y aceptado por API. `budgetLineId` es la línea
 * económica (treatment_budget_item.id), no el planItemId.
 */
export async function createAcceptedBudget(
  owner: OwnerFixture,
  ids: ClinicalIds,
  title = "Propuesta de Lucía",
): Promise<AcceptedBudget> {
  const { page } = owner
  const slug = owner.org.slug
  const apiPath = patientApiPath(ids.patientId)
  const { budgetId } = await createDraftBudget(owner, ids, title)
  await call(page, "POST", `${apiPath}/budgets/${budgetId}/present`, slug, {})
  await call(page, "POST", `${apiPath}/budgets/${budgetId}/decision`, slug, {
    decisions: [{ planItemId: ids.itemId, decision: "aceptado" }],
    decidedByContactId: null,
  })
  const detail = await call<{ items: Array<{ id: string; planItemId: string }> }>(
    page,
    "GET",
    `${apiPath}/budgets/${budgetId}`,
    slug,
  )
  const line = detail.items.find((entry) => entry.planItemId === ids.itemId)
  expect(line?.id, "el detalle del presupuesto incluye la línea del tratamiento").toBeTruthy()
  return { budgetId, budgetLineId: line?.id as string }
}

/** Representante legal vigente para decidir o pagar por la paciente. */
export async function grantLegalRepresentative(
  owner: OwnerFixture,
  ids: ClinicalIds,
  now = new Date(),
): Promise<void> {
  await call(
    owner.page,
    "POST",
    `${patientApiPath(ids.patientId)}/responsibilities`,
    owner.org.slug,
    {
      contactId: ids.contactId,
      kind: "representante_legal",
      startsAt: limaDate(now),
      endsAt: null,
      evidenceDocumentId: null,
    },
    201,
  )
}

const PRESCRIPTION_ITEMS = [
  {
    medicationName: "Ibuprofeno 400 mg",
    dose: "400 mg",
    route: "Oral",
    frequency: "Cada 8 horas",
    duration: "3 días",
    quantity: null,
    instructions: null,
  },
]

/**
 * Cadena económica y clínica del caso de agregación: responsabilidad, cargo,
 * pago de 200 con aplicación de 150, receta anulada y control completado.
 */
export async function setupAggregation(
  owner: OwnerFixture,
  ids: ClinicalIds,
): Promise<AggregationIds> {
  const { page } = owner
  const slug = owner.org.slug
  const apiPath = patientApiPath(ids.patientId)
  const now = new Date()
  const accepted = await createAcceptedBudget(owner, ids)
  await grantLegalRepresentative(owner, ids, now)
  const charge = await call<{ id: string }>(page, "POST", `${apiPath}/charges`, slug, {
    budgetItemId: accepted.budgetLineId,
  }, 201)
  const payment = await call<{ id: string }>(page, "POST", `${apiPath}/payments`, slug, {
    amountCents: 20000,
    currency: "PEN",
    paidAt: now.toISOString(),
    method: "efectivo",
    reference: null,
    payerContactId: ids.contactId,
  }, 201)
  await call(page, "POST", `${apiPath}/payments/${payment.id}/applications`, slug, {
    chargeId: charge.id,
    amountCents: 15000,
  })
  const prescription = await call<{ id: string }>(page, "POST", `${apiPath}/prescriptions`, slug, {
    planItemId: ids.itemId,
    notes: null,
    items: PRESCRIPTION_ITEMS,
  }, 201)
  await call(page, "POST", `${apiPath}/prescriptions/${prescription.id}/cancel`, slug, {
    reason: "Alergia registrada",
  })
  const tomorrow = new Date(now.getTime() + 86_400_000).toISOString()
  const followUp = await call<{ id: string }>(page, "POST", `${apiPath}/follow-ups`, slug, {
    kind: "tratamiento",
    title: "Control post-endodoncia",
    dueAt: tomorrow,
    instructions: null,
    planItemId: ids.itemId,
    encounterProcedureId: null,
    originEncounterId: ids.encounterId,
  }, 201)
  await call(page, "POST", `${apiPath}/follow-ups/${followUp.id}/schedule`, slug, {
    scheduledAt: tomorrow,
  })
  await call(page, "POST", `${apiPath}/follow-ups/${followUp.id}/complete`, slug, {
    encounterId: ids.encounterId,
    outcome: "Sin dolor; oclusión estable",
  })
  return {
    budgetId: accepted.budgetId,
    budgetLineId: accepted.budgetLineId,
    chargeId: charge.id,
    paymentId: payment.id,
    prescriptionId: prescription.id,
    followUpId: followUp.id,
  }
}
