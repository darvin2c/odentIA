import type { Db } from "@odentia/db"
import {
  clinicalFollowUp,
  encounter,
  encounterProcedure,
  prescription,
  prescriptionItem,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentPlan,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { and, asc, desc, eq, inArray } from "drizzle-orm"
import { listPatientDocuments } from "./clinical.js"
import { withPlanItemParts } from "./plan.js"
import type { ProductParts } from "./product-hooks.js"
import { productHooks } from "./products.js"
import { notFound } from "./errors.js"
import { getPatientAccount } from "./payments.js"
import { requirePatient } from "./patients.js"

export type TreatmentNextAction =
  | "definir"
  | "presupuestar"
  | "decidir"
  | "iniciar"
  | "reanudar"
  | "continuar"
  | "completar"
  | "controlar"

/**
 * Siguiente acción de un tratamiento con toda su información a la vista.
 * `null` solo cuando el tratamiento está cerrado y no admite más trabajo.
 */
export function deriveNextAction(input: {
  status: string
  decisionStatus: string
  budgetStatus: string | null
  openSession: boolean
}): TreatmentNextAction | null {
  const { status, decisionStatus, budgetStatus, openSession } = input
  if (status === "cancelado" || status === "reemplazado") return null
  if (status === "realizado") return "controlar"
  const budgetClosed = budgetStatus == null || budgetStatus === "cancelado"
  if (status === "suspendido") {
    if (budgetClosed || decisionStatus !== "aceptado") return "decidir"
    return "reanudar"
  }
  if (budgetClosed) return "presupuestar"
  // Lo que no se eligió de un presupuesto con opciones vuelve a esperar presupuesto.
  if (decisionStatus === "no_elegida") return "presupuestar"
  if (
    decisionStatus === "pendiente" ||
    decisionStatus === "pospuesto" ||
    budgetStatus === "borrador"
  ) {
    return "decidir"
  }
  if (decisionStatus !== "aceptado") return "definir"
  if (status === "en_curso") return openSession ? "completar" : "continuar"
  return "iniciar"
}

export async function listTreatmentJourneys(tx: Db, orgId: string, patientId: string, limit = 10) {
  await requirePatient(tx, orgId, patientId)
  const rows = await tx
    .select({ item: treatmentPlanItem, plan: treatmentPlan, budget: treatmentBudget })
    .from(treatmentPlanItem)
    .innerJoin(
      treatmentPlan,
      and(
        eq(treatmentPlan.id, treatmentPlanItem.planId),
        eq(treatmentPlan.organizationId, orgId),
        eq(treatmentPlan.patientId, patientId),
      ),
    )
    .leftJoin(
      treatmentBudget,
      and(
        eq(treatmentBudget.id, treatmentPlanItem.budgetId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .where(
      and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.patientId, patientId)),
    )
    .orderBy(desc(treatmentPlanItem.updatedAt), desc(treatmentPlanItem.id))
    .limit(Math.min(limit, 200))
  if (!rows.length) return []
  const ids = rows.map((r) => r.item.id)
  const procedures = await tx
    .select({ procedure: encounterProcedure, encounter })
    .from(encounterProcedure)
    .innerJoin(
      encounter,
      and(
        eq(encounter.id, encounterProcedure.encounterId),
        eq(encounter.organizationId, orgId),
        eq(encounter.patientId, patientId),
      ),
    )
    .where(
      and(
        eq(encounterProcedure.organizationId, orgId),
        inArray(encounterProcedure.planItemId, ids),
      ),
    )
    .orderBy(desc(encounterProcedure.createdAt), desc(encounterProcedure.id))
  const controls = await tx
    .select()
    .from(clinicalFollowUp)
    .where(
      and(
        eq(clinicalFollowUp.organizationId, orgId),
        eq(clinicalFollowUp.patientId, patientId),
        inArray(clinicalFollowUp.planItemId, ids),
        inArray(clinicalFollowUp.status, ["pendiente", "programado"]),
      ),
    )
    .orderBy(asc(clinicalFollowUp.dueAt), asc(clinicalFollowUp.id))
  // Resumen clínico: estado y próxima acción de cada tratamiento, sin saldos.
  // La caja se consulta con `finance.read` en la cuenta del paciente.
  return rows.map((row) => {
    const lastSession = procedures.find((p) => p.procedure.planItemId === row.item.id) ?? null
    const nextFollowUp = controls.find((c) => c.planItemId === row.item.id) ?? null
    const nextAction = deriveNextAction({
      status: row.item.status,
      decisionStatus: row.item.decisionStatus,
      budgetStatus: row.budget?.status ?? null,
      openSession: lastSession?.encounter.status === "borrador",
    })
    return {
      ...row,
      decision: row.item.decisionStatus,
      clinicalStatus: row.item.status,
      lastSession,
      nextFollowUp,
      nextAction,
    }
  })
}

/** Saldos del tratamiento separados por moneda: nunca se suman importes distintos. */
function balancesByCurrency(
  charges: Array<{ id: string; currency: string; amountCents: number }>,
  appliedByCharge: Map<string, number>,
) {
  const units = [...new Set(charges.map((c) => c.currency))].sort()
  return units.map((unit) => {
    const unitCharges = charges.filter((c) => c.currency === unit)
    const chargedCents = unitCharges.reduce((sum, c) => sum + c.amountCents, 0)
    const appliedCents = unitCharges.reduce((sum, c) => sum + (appliedByCharge.get(c.id) ?? 0), 0)
    return {
      currency: unit,
      chargedCents,
      appliedCents,
      outstandingCents: chargedCents - appliedCents,
    }
  })
}

/** Aplicaciones activas por cargo, solo de los cargos indicados. */
function appliedByCharge(
  charges: Array<{ id: string }>,
  applications: Array<{ chargeId: string; amountCents: number; voidedAt: Date | null }>,
): Map<string, number> {
  const ids = new Set(charges.map((c) => c.id))
  const applied = new Map<string, number>()
  for (const application of applications) {
    if (application.voidedAt || !ids.has(application.chargeId)) continue
    applied.set(
      application.chargeId,
      (applied.get(application.chargeId) ?? 0) + application.amountCents,
    )
  }
  return applied
}

export async function getTreatmentJourney(
  tx: Db,
  orgId: string,
  patientId: string,
  itemId: string,
  options: { finance: boolean },
) {
  await requirePatient(tx, orgId, patientId)
  const scope = and(
    eq(treatmentPlanItem.organizationId, orgId),
    eq(treatmentPlanItem.patientId, patientId),
  )
  const [row] = await tx
    .select()
    .from(treatmentPlanItem)
    .where(and(scope, eq(treatmentPlanItem.id, itemId)))
  if (!row) throw notFound("Tratamiento")
  // Con lo que le agrega el producto (odentIA: su hallazgo de origen).
  const item = await withPlanItemParts(tx, orgId, row)
  const [plan] = await tx
    .select()
    .from(treatmentPlan)
    .where(
      and(
        eq(treatmentPlan.id, item.planId),
        eq(treatmentPlan.organizationId, orgId),
        eq(treatmentPlan.patientId, patientId),
      ),
    )
  const [originEncounter] = item.sourceEncounterId
    ? await tx
        .select()
        .from(encounter)
        .where(
          and(
            eq(encounter.id, item.sourceEncounterId),
            eq(encounter.organizationId, orgId),
            eq(encounter.patientId, patientId),
          ),
        )
    : []
  const product = await (await productHooks(tx, orgId)).journeyParts(tx, { orgId, patientId, planItemId: item.id })
  const [supersedes] = item.supersedesItemId
    ? await tx
        .select()
        .from(treatmentPlanItem)
        .where(and(scope, eq(treatmentPlanItem.id, item.supersedesItemId)))
    : []
  const replacedBy = await tx
    .select()
    .from(treatmentPlanItem)
    .where(and(scope, eq(treatmentPlanItem.supersedesItemId, item.id)))
  const budgetHistory = await tx
    .select({ budget: treatmentBudget, line: treatmentBudgetItem })
    .from(treatmentBudgetItem)
    .innerJoin(
      treatmentBudget,
      and(
        eq(treatmentBudget.id, treatmentBudgetItem.budgetId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .where(
      and(
        eq(treatmentBudgetItem.organizationId, orgId),
        eq(treatmentBudgetItem.patientId, patientId),
        eq(treatmentBudgetItem.planItemId, itemId),
      ),
    )
    .orderBy(asc(treatmentBudget.budgetNumber), asc(treatmentBudget.revisionNumber))
  const procedures = await tx
    .select({ procedure: encounterProcedure, encounter })
    .from(encounterProcedure)
    .innerJoin(
      encounter,
      and(
        eq(encounter.id, encounterProcedure.encounterId),
        eq(encounter.organizationId, orgId),
        eq(encounter.patientId, patientId),
      ),
    )
    .where(
      and(eq(encounterProcedure.organizationId, orgId), eq(encounterProcedure.planItemId, itemId)),
    )
    .orderBy(asc(encounterProcedure.createdAt), asc(encounterProcedure.id))
  const followUps = await tx
    .select()
    .from(clinicalFollowUp)
    .where(
      and(
        eq(clinicalFollowUp.organizationId, orgId),
        eq(clinicalFollowUp.patientId, patientId),
        eq(clinicalFollowUp.planItemId, itemId),
      ),
    )
    .orderBy(asc(clinicalFollowUp.dueAt))
  const headers = await tx
    .select()
    .from(prescription)
    .where(
      and(
        eq(prescription.organizationId, orgId),
        eq(prescription.patientId, patientId),
        eq(prescription.planItemId, itemId),
      ),
    )
    .orderBy(asc(prescription.issuedAt))
  const medications = headers.length
    ? await tx
        .select()
        .from(prescriptionItem)
        .where(
          and(
            eq(prescriptionItem.organizationId, orgId),
            eq(prescriptionItem.patientId, patientId),
            inArray(
              prescriptionItem.prescriptionId,
              headers.map((h) => h.id),
            ),
          ),
        )
    : []
  const prescriptions = headers.map((h) => ({
    ...h,
    items: medications.filter((m) => m.prescriptionId === h.id),
  }))
  // Caja del tratamiento solo para quien tiene `finance.read`: odontología ve
  // el recorrido clínico completo sin cargos, pagos ni saldos (`finance: null`).
  const finance = options.finance ? await treatmentFinance(tx, orgId, patientId, itemId) : null
  const paymentIds = new Set(finance?.payments.map((p) => p.id) ?? [])
  const allDocuments = await listPatientDocuments(tx, orgId, patientId)
  const documents = allDocuments.filter(
    (d) =>
      d.planItemId === itemId ||
      budgetHistory.some((b) => b.budget.id === d.budgetId) ||
      procedures.some((p) => p.procedure.id === d.encounterProcedureId) ||
      prescriptions.some((p) => p.id === d.prescriptionId) ||
      followUps.some((f) => f.id === d.followUpId) ||
      (d.paymentId != null && paymentIds.has(d.paymentId)),
  )
  // La próxima acción se deriva aquí, con el tratamiento y su atención a la vista:
  // nunca depende de resúmenes truncados a los últimos tratamientos.
  const [currentBudget] = item.budgetId
    ? await tx
        .select({ status: treatmentBudget.status })
        .from(treatmentBudget)
        .where(
          and(
            eq(treatmentBudget.id, item.budgetId),
            eq(treatmentBudget.organizationId, orgId),
            eq(treatmentBudget.patientId, patientId),
          ),
        )
    : []
  const nextAction = deriveNextAction({
    status: item.status,
    decisionStatus: item.decisionStatus,
    budgetStatus: currentBudget?.status ?? null,
    openSession: procedures.some((p) => p.encounter.status === "borrador"),
  })
  const journey = {
    item,
    plan,
    originEncounter: originEncounter ?? null,
    replacedBy,
    supersedes: supersedes ?? null,
    budgetHistory,
    procedures,
    followUps,
    prescriptions,
    documents,
    finance,
    nextAction,
  }
  // Lo del producto (odentIA: `originFinding`, el hallazgo que lo motivó).
  return { ...journey, ...product } as typeof journey & ProductParts
}

export type TreatmentFinance = NonNullable<
  Awaited<ReturnType<typeof getTreatmentJourney>>["finance"]
>

/** Cargos, pagos y saldos del tratamiento: la parte de caja del recorrido. */
async function treatmentFinance(tx: Db, orgId: string, patientId: string, itemId: string) {
  const account = await getPatientAccount(tx, orgId, patientId)
  const charges = account.charges.filter((c) => c.planItemId === itemId)
  const activeCharges = charges.filter((c) => !c.voidedAt)
  const chargeIds = new Set(charges.map((c) => c.id))
  const applications = account.applications.filter((a) => chargeIds.has(a.chargeId))
  const paymentIds = new Set(applications.map((a) => a.paymentId))
  return {
    charges,
    payments: account.payments.filter((p) => paymentIds.has(p.id)),
    applications,
    refunds: account.refunds.filter((r) => paymentIds.has(r.paymentId)),
    balances: balancesByCurrency(
      activeCharges,
      appliedByCharge(activeCharges, account.applications),
    ),
  }
}
