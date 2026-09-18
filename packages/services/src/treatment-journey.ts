import type { Db } from "@odentia/db"
import { clinicalFollowUp, encounter, encounterProcedure, prescription, prescriptionItem, treatmentBudget, treatmentBudgetItem, treatmentOptionGroup, treatmentPlan, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { and, asc, desc, eq, inArray } from "drizzle-orm"
import { listPatientDocuments } from "./clinical.js"
import { notFound } from "./errors.js"
import { getPatientAccount } from "./payments.js"
import { requirePatient } from "./patients.js"

export type TreatmentNextAction = "definir" | "presupuestar" | "decidir" | "iniciar" | "continuar" | "completar" | "controlar"

export async function listTreatmentJourneys(tx: Db, orgId: string, patientId: string, limit = 10) {
  await requirePatient(tx, orgId, patientId)
  const rows = await tx.select({ item: treatmentPlanItem, plan: treatmentPlan, budget: treatmentBudget }).from(treatmentPlanItem)
    .innerJoin(treatmentPlan, and(eq(treatmentPlan.id, treatmentPlanItem.planId), eq(treatmentPlan.organizationId, orgId), eq(treatmentPlan.patientId, patientId)))
    .leftJoin(treatmentBudget, and(eq(treatmentBudget.id, treatmentPlanItem.budgetId), eq(treatmentBudget.organizationId, orgId), eq(treatmentBudget.patientId, patientId)))
    .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.patientId, patientId)))
    .orderBy(desc(treatmentPlanItem.updatedAt), desc(treatmentPlanItem.id)).limit(Math.min(limit, 200))
  if (!rows.length) return []
  const ids = rows.map(r => r.item.id)
  const procedures = await tx.select({ procedure: encounterProcedure, encounter }).from(encounterProcedure)
    .innerJoin(encounter, and(eq(encounter.id, encounterProcedure.encounterId), eq(encounter.organizationId, orgId), eq(encounter.patientId, patientId)))
    .where(and(eq(encounterProcedure.organizationId, orgId), inArray(encounterProcedure.planItemId, ids)))
    .orderBy(desc(encounterProcedure.createdAt), desc(encounterProcedure.id))
  const controls = await tx.select().from(clinicalFollowUp).where(and(eq(clinicalFollowUp.organizationId, orgId), eq(clinicalFollowUp.patientId, patientId), inArray(clinicalFollowUp.planItemId, ids), inArray(clinicalFollowUp.status, ["pendiente", "programado"]))).orderBy(asc(clinicalFollowUp.dueAt), asc(clinicalFollowUp.id))
  const account = await getPatientAccount(tx, orgId, patientId)
  return rows.map(row => {
    const lastSession = procedures.find(p => p.procedure.planItemId === row.item.id) ?? null
    const nextFollowUp = controls.find(c => c.planItemId === row.item.id) ?? null
    const charges = account.charges.filter(c => c.planItemId === row.item.id && !c.voidedAt)
    const chargeIds = new Set(charges.map(c => c.id))
    const applied = account.applications.filter(a => chargeIds.has(a.chargeId) && !a.voidedAt).reduce((sum, a) => sum + a.amountCents, 0)
    let nextAction: TreatmentNextAction = "definir"
    if (row.item.status === "realizado") nextAction = "controlar"
    else if (!["cancelado", "reemplazado", "suspendido"].includes(row.item.status)) {
      if (!row.budget || ["cancelado", "historico"].includes(row.budget.status)) nextAction = "presupuestar"
      else if (row.item.decisionStatus === "pendiente" || row.item.decisionStatus === "pospuesto" || row.budget.status === "borrador") nextAction = "decidir"
      else if (row.item.decisionStatus === "aceptado") nextAction = row.item.status === "en_curso"
        ? lastSession?.encounter.status === "borrador" ? "completar" : "continuar" : "iniciar"
    }
    return { ...row, decision: row.item.decisionStatus, clinicalStatus: row.item.status, lastSession, nextFollowUp, nextAction,
      balance: { currency: row.item.currency, outstandingCents: charges.reduce((sum, c) => sum + c.amountCents, 0) - applied } }
  })
}

export async function getTreatmentJourney(tx: Db, orgId: string, patientId: string, itemId: string) {
  await requirePatient(tx, orgId, patientId)
  const scope = and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.patientId, patientId))
  const [item] = await tx.select().from(treatmentPlanItem).where(and(scope, eq(treatmentPlanItem.id, itemId)))
  if (!item) throw notFound("Tratamiento")
  const [plan] = await tx.select().from(treatmentPlan).where(and(eq(treatmentPlan.id, item.planId), eq(treatmentPlan.organizationId, orgId), eq(treatmentPlan.patientId, patientId)))
  const [originEncounter] = item.sourceEncounterId ? await tx.select().from(encounter).where(and(eq(encounter.id, item.sourceEncounterId), eq(encounter.organizationId, orgId), eq(encounter.patientId, patientId))) : []
  const [supersedes] = item.supersedesItemId ? await tx.select().from(treatmentPlanItem).where(and(scope, eq(treatmentPlanItem.id, item.supersedesItemId))) : []
  const replacedBy = await tx.select().from(treatmentPlanItem).where(and(scope, eq(treatmentPlanItem.supersedesItemId, item.id)))
  const [optionGroup] = item.optionGroupId ? await tx.select().from(treatmentOptionGroup).where(and(eq(treatmentOptionGroup.id, item.optionGroupId), eq(treatmentOptionGroup.organizationId, orgId), eq(treatmentOptionGroup.patientId, patientId))) : []
  const alternatives = item.optionGroupId ? await tx.select().from(treatmentPlanItem).where(and(scope, eq(treatmentPlanItem.optionGroupId, item.optionGroupId))) : []
  const budgetHistory = await tx.select({ budget: treatmentBudget, line: treatmentBudgetItem }).from(treatmentBudgetItem)
    .innerJoin(treatmentBudget, and(eq(treatmentBudget.id, treatmentBudgetItem.budgetId), eq(treatmentBudget.organizationId, orgId), eq(treatmentBudget.patientId, patientId)))
    .where(and(eq(treatmentBudgetItem.organizationId, orgId), eq(treatmentBudgetItem.patientId, patientId), eq(treatmentBudgetItem.planItemId, itemId))).orderBy(asc(treatmentBudget.budgetNumber), asc(treatmentBudget.revisionNumber))
  const procedures = await tx.select({ procedure: encounterProcedure, encounter }).from(encounterProcedure)
    .innerJoin(encounter, and(eq(encounter.id, encounterProcedure.encounterId), eq(encounter.organizationId, orgId), eq(encounter.patientId, patientId)))
    .where(and(eq(encounterProcedure.organizationId, orgId), eq(encounterProcedure.planItemId, itemId))).orderBy(asc(encounterProcedure.createdAt), asc(encounterProcedure.id))
  const followUps = await tx.select().from(clinicalFollowUp).where(and(eq(clinicalFollowUp.organizationId, orgId), eq(clinicalFollowUp.patientId, patientId), eq(clinicalFollowUp.planItemId, itemId))).orderBy(asc(clinicalFollowUp.dueAt))
  const headers = await tx.select().from(prescription).where(and(eq(prescription.organizationId, orgId), eq(prescription.patientId, patientId), eq(prescription.planItemId, itemId))).orderBy(asc(prescription.issuedAt))
  const medications = headers.length ? await tx.select().from(prescriptionItem).where(and(eq(prescriptionItem.organizationId, orgId), eq(prescriptionItem.patientId, patientId), inArray(prescriptionItem.prescriptionId, headers.map(h => h.id)))) : []
  const prescriptions = headers.map(h => ({ ...h, items: medications.filter(m => m.prescriptionId === h.id) }))
  const account = await getPatientAccount(tx, orgId, patientId)
  const charges = account.charges.filter(c => c.planItemId === itemId)
  const chargeIds = new Set(charges.map(c => c.id))
  const applications = account.applications.filter(a => chargeIds.has(a.chargeId))
  const paymentIds = new Set(applications.map(a => a.paymentId))
  const payments = account.payments.filter(p => paymentIds.has(p.id))
  const allDocuments = await listPatientDocuments(tx, orgId, patientId)
  const documents = allDocuments.filter(d => d.planItemId === itemId || budgetHistory.some(b => b.budget.id === d.budgetId) || procedures.some(p => p.procedure.id === d.encounterProcedureId) || prescriptions.some(p => p.id === d.prescriptionId) || followUps.some(f => f.id === d.followUpId) || (d.paymentId != null && paymentIds.has(d.paymentId)))
  return { item, plan, originEncounter: originEncounter ?? null, replacedBy, supersedes: supersedes ?? null, optionGroup: optionGroup ? { ...optionGroup, alternatives } : null, budgetHistory, procedures, followUps, prescriptions, documents, charges, payments, applications, refunds: account.refunds.filter(r => paymentIds.has(r.paymentId)) }
}
