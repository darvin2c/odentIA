/** Presupuestos de tratamiento: tipos de vista + llamadas a la API.
 *
 * Contrato servidor: `packages/services/src/budgets.ts`.
 * - GET /api/patients/:id/budgets?planId= -> { data: BudgetWithTotals[] }
 * - GET /api/patients/:id/budgets/:budgetId -> { data: BudgetWithTotals }
 * - POST /api/patients/:id/budgets { planId, itemIds, title?, notes? } -> 201
 * - PATCH /api/patients/:id/budgets/:budgetId { title?, notes? } (solo borrador)
 * - POST /api/patients/:id/budgets/:budgetId/present {} (borrador->presentado)
 * - POST /api/patients/:id/budgets/:budgetId/decision { decisions, decidedByContactId?, decisionNote? }
 * - POST /api/patients/:id/budgets/:budgetId/cancel {}
 * - POST /api/patients/:id/plan/items exige planId + atención borrador de origen.
 * - GET/POST /api/patients/:id/plans para el plan clínico longitudinal.
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

export type PlanDecision = "pendiente" | "aceptado" | "rechazado" | "sin_registro"

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
  priceCents: number | null
  currency: string
  decision: PlanDecision
  itemStatus: string
}

/** Ítem del plan con decisión derivada de su línea vigente (tipos de Main). */
export type BudgetPlanItem = PlanItem

export interface BudgetWithTotals extends Budget {
  items: BudgetLine[]
  totalCents: number | null
  acceptedCents: number | null
}

/** Parche de un ítem pendiente (oferta, sitio, detalle, diagnóstico) con atención borrador como contexto. */
export function patchPlanItemApi(
  patientId: string,
  itemId: string,
  body: {
    serviceId?: string
    detail?: string | null
    diagnosisCode?: string | null
    toothNumber?: number | null
    surfaces?: string[] | null
    quadrant?: number | null
    arch?: string | null
    encounterId: string
  },
): Promise<{ data: BudgetPlanItem }> {
  return apiFetch<{ data: BudgetPlanItem }>(`/api/patients/${patientId}/plan/items/${itemId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}


export const BUDGET_CURRENCIES = ["PEN", "USD", "EUR"] as const
export type BudgetCurrency = (typeof BUDGET_CURRENCIES)[number]

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
    case "sin_registro":
      return "Sin registro"
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

export function presentBudgetApi(patientId: string, budgetId: string): Promise<{ data: Budget }> {
  return apiFetch<{ data: Budget }>(`${budgetsBase(patientId)}/${budgetId}/present`, {
    method: "POST",
    body: JSON.stringify({}),
  })
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

/** Planes clínicos longitudinales del paciente. */
export function fetchTreatmentPlans(
  patientId: string,
): Promise<{ data: TreatmentPlanWithStatus[] }> {
  return apiFetch<{ data: TreatmentPlanWithStatus[] }>(`/api/patients/${patientId}/plans`)
}

export function fetchTreatmentPlanDetail(
  patientId: string,
  planId: string,
): Promise<{
  data: { plan: TreatmentPlan; status: string; items: PlanItem[]; budgetIds: string[] }
}> {
  return apiFetch<{
    data: { plan: TreatmentPlan; status: string; items: PlanItem[]; budgetIds: string[] }
  }>(`/api/patients/${patientId}/plans/${planId}`)
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

/** Indica un tratamiento en el plan desde la atención borrador (precio desde la oferta, nunca manual). */
export function addPlanItemToBudget(
  patientId: string,
  body: Record<string, unknown>,
): Promise<{ data: BudgetPlanItem }> {
  return apiFetch<{ data: BudgetPlanItem }>(`/api/patients/${patientId}/plan/items`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/** Indica un tratamiento por pieza (ámbito tooth) en una sola transacción. */
export function addPlanItemsBatchToBudget(
  patientId: string,
  body: Record<string, unknown>,
): Promise<{ data: BudgetPlanItem[] }> {
  return apiFetch<{ data: BudgetPlanItem[] }>(`/api/patients/${patientId}/plan/items/batch`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}
