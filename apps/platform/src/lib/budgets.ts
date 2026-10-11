/** Presupuestos de tratamiento: tipos de vista + llamadas a la API.
 *
 * Contrato servidor: `packages/services/src/budgets.ts`.
 * - GET /api/patients/:id/budgets?planId= -> { data: BudgetWithTotals[] }
 * - GET /api/patients/:id/budgets/:budgetId -> { data: BudgetWithTotals }
 * - GET /api/patients/:id/budgets/:budgetId/print -> payload A4 (quotation 310)
 * - POST /api/patients/:id/budgets { planId, itemIds, title?, notes? } -> 201
 * - PATCH /api/patients/:id/budgets/:budgetId { title?, notes? } (solo borrador)
 * - POST /api/patients/:id/budgets/:budgetId/lines { lines } (precio+promo, borrador)
 * - POST /api/patients/:id/budgets/:budgetId/deliver {} (borrador->presentado)
 * - POST /api/patients/:id/budgets/:budgetId/decision { decisions, decidedByContactId?, decisionNote? }
 * - POST /api/patients/:id/budgets/:budgetId/cancel {}
 * - POST /api/patients/:id/plan/items exige planId + atención borrador de origen.
 * - GET/POST /api/patients/:id/plans para el plan clínico longitudinal.
 * - PDF servidor: /api/patients/:id/financial-document-pdf?documentType=budget&documentId=
 *
 * Aquí solo tipos de vista y fetch: nunca se recalculan totales ni se
 * reinterpretan estados; el servidor es la fuente (totalCents/acceptedCents).
 */
import { apiFetch } from "./api"
import type { PlanItem, TreatmentPlan, TreatmentPlanWithStatus } from "./patients"

export type BudgetStatus =
  | "borrador"
  | "presentado"
  | "aceptado"
  | "parcial"
  | "rechazado"
  | "cancelado"
  | "historico"

export const BUDGET_STATUSES: readonly BudgetStatus[] = [
  "borrador",
  "presentado",
  "aceptado",
  "parcial",
  "rechazado",
  "cancelado",
  "historico",
]

export type PlanDecision = "pendiente" | "aceptado" | "pospuesto" | "rechazado" | "reemplazado"

export interface Budget {
  id: string
  organizationId?: string
  patientId?: string
  planId: string
  budgetNumber: number
  title: string
  currency: string
  status: BudgetStatus | string
  notes: string | null
  acceptedByName: string | null
  /** Contacto que asumió la decisión (paciente o representante legal). */
  decisionContactId?: string | null
  decisionNote: string | null
  decidedAt: string | null
  decidedBy?: string | null
  createdBy?: string | null
  createdAt: string
  updatedAt?: string
}

/** Línea económica snapshot del documento (decisión por línea, estado clínico unido). */
export interface BudgetLine {
  id: string
  planId: string
  budgetId: string
  planItemId: string
  serviceId: string | null
  title: string
  scope: string | null
  toothNumber: number | null
  surfaces: string[]
  quadrant: number | null
  arch: string | null
  /** Precio final acordado por unidad (total o por sesión según billingMode). */
  priceCents: number | null
  /** Tarifa original al cotizar (referencia del descuento). */
  tariffPriceCents: number | null
  priceReason: string | null
  promotionId: string | null
  promotionName: string | null
  promotionMode: string | null
  /** 'treatment' una vez, 'session' por visita atendida. */
  billingMode: string
  sessionsPlanned: number | null
  currency: string
  decision: PlanDecision
  itemStatus: string
}

export interface BudgetWithTotals extends Budget {
  items: BudgetLine[]
  totalCents: number | null
  acceptedCents: number | null
  tariffTotalCents: number | null
  discountCents: number | null
}



/** Etiqueta en español del estado del presupuesto. */
export function budgetStatusLabel(status: string): string {
  switch (status) {
    case "borrador":
      return "Borrador"
    case "presentado":
      return "Presentado"
    case "aceptado":
      return "Aceptado"
    case "parcial":
      return "Parcial"
    case "rechazado":
      return "Rechazado"
    case "cancelado":
      return "Cancelado"
    case "historico":
      return "Histórico"
    default:
      return status
  }
}

/** Etiqueta en español de la decisión del tratamiento (separada de la ejecución clínica). */
export function planDecisionLabel(decision: string | null | undefined): string {
  switch (decision) {
    case "aceptado":
      return "Aceptado"
    case "rechazado":
      return "Rechazado"
    case "pospuesto":
      return "Pospuesto"
    case "reemplazado":
      return "Reemplazado"
    case "pendiente":
    case null:
    case undefined:
      return "Pendiente de decisión"
    default:
      return String(decision)
  }
}

/** "Presupuesto N.º 3". */
export function budgetNumberLabel(n: number): string {
  return `Presupuesto N.º ${n}`
}

function budgetsBase(patientId: string): string {
  return `/api/patients/${patientId}/budgets`
}

export function fetchBudgets(
  patientId: string,
  planId?: string,
): Promise<{ data: BudgetWithTotals[] }> {
  const suffix = planId ? `?planId=${encodeURIComponent(planId)}` : ""
  return apiFetch<{ data: BudgetWithTotals[] }>(`${budgetsBase(patientId)}${suffix}`)
}

export function fetchBudgetDetail(
  patientId: string,
  budgetId: string,
): Promise<{ data: BudgetWithTotals }> {
  return apiFetch<{ data: BudgetWithTotals }>(`${budgetsBase(patientId)}/${budgetId}`)
}

export interface CreateBudgetBody {
  planId: string
  itemIds: string[]
  title?: string | null
  notes?: string | null
}

export function createBudgetApi(
  patientId: string,
  body: CreateBudgetBody,
): Promise<{ data: BudgetWithTotals }> {
  return apiFetch<{ data: BudgetWithTotals }>(budgetsBase(patientId), {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export interface UpdateBudgetBody {
  title?: string
  notes?: string | null
}

export function updateBudgetApi(
  patientId: string,
  budgetId: string,
  body: UpdateBudgetBody,
): Promise<{ data: Budget }> {
  return apiFetch<{ data: Budget }>(`${budgetsBase(patientId)}/${budgetId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}

/** Entregar el presupuesto: imprimir o enviar lo entrega (no hay paso presentar). */
export function deliverBudgetApi(patientId: string, budgetId: string): Promise<{ data: Budget }> {
  return apiFetch<{ data: Budget }>(`${budgetsBase(patientId)}/${budgetId}/deliver`, {
    method: "POST",
    body: JSON.stringify({}),
  })
}

export interface AdjustBudgetLineBody {
  planItemId: string
  priceCents?: number | null
  reason?: string | null
  promotionId?: string | null
  promotionFinalPriceCents?: number | null
}

/** Precio acordado por línea con motivo + promoción opt-in (solo borrador). */
export function adjustBudgetLinesApi(
  patientId: string,
  budgetId: string,
  body: { lines: AdjustBudgetLineBody[] },
): Promise<{ data: BudgetWithTotals }> {
  return apiFetch<{ data: BudgetWithTotals }>(`${budgetsBase(patientId)}/${budgetId}/lines`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export interface BudgetPrintPayload {
  quotationCode: "310"
  paper: "A4"
  budgetNumber: number
  revisionNumber: number
  title: string
  planTitle: string
  status: string
  isDraft: boolean
  currency: string
  locale: string
  timezone: string
  issuedAt: string
  clinic: { name: string; address: string | null; phone: string | null }
  patient: { displayName: string; docType: string | null; docNumber: string | null }
  professional: { name: string; title: string | null; registration: string | null } | null
  lines: Array<{
    title: string
    detail: string | null
    tariffCents: number | null
    priceCents: number | null
    discountCents: number | null
    promotionName: string | null
    billingMode: string
    sessionsPlanned: number | null
    decision: string
  }>
  subtotalCents: number | null
  discountCents: number | null
  totalCents: number | null
  paymentNote: string
  fiscalNote: string
}

export function fetchBudgetPrint(
  patientId: string,
  budgetId: string,
): Promise<{ data: BudgetPrintPayload }> {
  return apiFetch<{ data: BudgetPrintPayload }>(`${budgetsBase(patientId)}/${budgetId}/print`)
}

/** Documento PDF del servidor (mismo que se envía al paciente). */
export function budgetPdfUrl(patientId: string, budgetId: string): string {
  return `/api/patients/${patientId}/financial-document-pdf?documentType=budget&documentId=${budgetId}`
}

export interface DecideBudgetBody {
  decisions: Array<{ planItemId: string; decision: "aceptado" | "rechazado" | "pospuesto" }>
  decidedByContactId?: string | null
  decisionNote?: string | null
}

export function decideBudgetApi(
  patientId: string,
  budgetId: string,
  body: DecideBudgetBody,
): Promise<{ data: BudgetWithTotals }> {
  return apiFetch<{ data: BudgetWithTotals }>(`${budgetsBase(patientId)}/${budgetId}/decision`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function cancelBudgetApi(patientId: string, budgetId: string): Promise<{ data: Budget }> {
  return apiFetch<{ data: Budget }>(`${budgetsBase(patientId)}/${budgetId}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  })
}

export interface ReviseBudgetBody {
  itemIds: string[]
  title?: string | null
  notes?: string | null
  reason: string
}

/** Nueva revisión del mismo presupuesto: conserva el número y versiona el documento. */
export function reviseBudgetApi(
  patientId: string,
  budgetId: string,
  body: ReviseBudgetBody,
): Promise<{ data: BudgetWithTotals }> {
  return apiFetch<{ data: BudgetWithTotals }>(`${budgetsBase(patientId)}/${budgetId}/revise`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/** Planes clínicos longitudinales del paciente. */
export function fetchTreatmentPlans(
  patientId: string,
): Promise<{ data: TreatmentPlanWithStatus[] }> {
  return apiFetch<{ data: TreatmentPlanWithStatus[] }>(`/api/patients/${patientId}/plans`)
}

export interface PlanOptionGroup {
  id: string
  planId: string
  patientId: string
  title: string
}

export interface PlanDetail {
  plan: TreatmentPlan
  status: string
  items: PlanItem[]
  budgetIds: string[]
  optionGroups: PlanOptionGroup[]
}

export function fetchTreatmentPlanDetail(
  patientId: string,
  planId: string,
): Promise<{ data: PlanDetail }> {
  return apiFetch<{ data: PlanDetail }>(`/api/patients/${patientId}/plans/${planId}`)
}

export function createTreatmentPlanApi(
  patientId: string,
  body: { title: string; originEncounterId: string },
): Promise<{ data: TreatmentPlan }> {
  return apiFetch<{ data: TreatmentPlan }>(`/api/patients/${patientId}/plans`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}


