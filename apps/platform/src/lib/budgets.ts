/** Presupuestos de tratamiento: tipos de vista + llamadas a la API.
 *
 * Contrato servidor: `packages/services/src/budgets.ts`.
 * - GET /api/patients/:id/budgets?planId= -> { data: BudgetWithTotals[] }
 * - GET /api/patients/:id/budgets/:budgetId -> { data: BudgetWithTotals }
 * - POST /api/patients/:id/budgets { planId, itemIds, title?, notes? } -> 201
 * - PATCH /api/patients/:id/budgets/:budgetId { title?, notes? } (solo borrador)
 * - POST /api/patients/:id/budgets/:budgetId/lines { lines } (precio, motivo, promoción
 *   y visitas previstas; solo borrador)
 * - POST /api/patients/:id/budgets/:budgetId/deliver {} (borrador->presentado; 409
 *   PROMOTION_NOT_LIVE si una promoción del borrador ya no está vigente)
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
  | "pospuesto"
  | "sustituido"
  | "cancelado"
  | "historico"

export const BUDGET_STATUSES: readonly BudgetStatus[] = [
  "borrador",
  "presentado",
  "aceptado",
  "parcial",
  "rechazado",
  "pospuesto",
  "sustituido",
  "cancelado",
  "historico",
]

/** Estados en los que todavía se puede anotar (o completar) la respuesta. */
export const BUDGET_ANSWERABLE_STATUSES: readonly string[] = ["presentado", "parcial", "pospuesto"]

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
  /** Presupuesto al que esta revisión sustituye (sus tratamientos se eligen al crearla). */
  supersedesBudgetId?: string | null
  /** Cuándo se entregó al paciente (impreso o enviado). */
  presentedAt?: string | null
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
  /** Total de la línea: el precio o, por sesión, precio por visita × visitas previstas. */
  lineTotalCents: number | null
  /** El mismo total a la tarifa de referencia. */
  tariffLineTotalCents: number | null
  /** Rebaja de la línea frente a su tarifa (null si no baja): «{importe} menos que la tarifa». */
  lineDiscountCents: number | null
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

/**
 * Etiqueta del estado del presupuesto, con las palabras de la clínica: lo que
 * el servidor llama «presentado» es un presupuesto entregado al paciente.
 */
export function budgetStatusLabel(status: string): string {
  switch (status) {
    case "borrador":
      return "Borrador"
    case "presentado":
      return "Entregado"
    case "aceptado":
      return "Aceptado"
    case "parcial":
      return "Aceptado en parte"
    case "rechazado":
      return "No aceptado"
    case "pospuesto":
      return "Lo va a pensar"
    case "sustituido":
      return "Reemplazado por una revisión"
    case "cancelado":
      return "Cancelado"
    case "historico":
      return "Histórico"
    default: {
      // Un estado nuevo nunca llega a pantalla como código crudo.
      const text = status.replace(/[_-]+/g, " ").trim()
      return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Sin estado"
    }
  }
}

/** Respuesta del paciente a un tratamiento del presupuesto, como se anota en la ficha. */
export function budgetAnswerLabel(decision: string | null | undefined): string {
  switch (decision) {
    case "aceptado":
      return "Acepta"
    case "pospuesto":
      return "Lo piensa"
    case "rechazado":
      return "No acepta"
    case "reemplazado":
      return "Reemplazado"
    default:
      return "Sin respuesta"
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
  /** Visitas previstas de una línea que se cobra por sesión. */
  sessionsPlanned?: number
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

/** Añade tratamientos del plan a un borrador, con las reglas de prepararlo. */
export function addBudgetItemsApi(
  patientId: string,
  budgetId: string,
  itemIds: string[],
): Promise<{ data: BudgetWithTotals }> {
  return apiFetch<{ data: BudgetWithTotals }>(`${budgetsBase(patientId)}/${budgetId}/items`, {
    method: "POST",
    body: JSON.stringify({ itemIds }),
  })
}

/** Quita tratamientos de un borrador: vuelven a quedar sin presupuestar. */
export function removeBudgetItemsApi(
  patientId: string,
  budgetId: string,
  itemIds: string[],
): Promise<{ data: BudgetWithTotals }> {
  return apiFetch<{ data: BudgetWithTotals }>(
    `${budgetsBase(patientId)}/${budgetId}/items/remove`,
    { method: "POST", body: JSON.stringify({ itemIds }) },
  )
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


