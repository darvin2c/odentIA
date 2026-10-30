/** Presupuestos de tratamiento: tipos de vista + llamadas a la API.
 *
 * Contrato servidor: `packages/services/src/budgets.ts` y `budget-send.ts`.
 * - GET /api/patients/:id/budgets?planId= -> { data: BudgetWithTotals[] }
 * - GET /api/patients/:id/budgets/:budgetId -> { data: BudgetWithTotals }
 * - POST /api/patients/:id/budgets { planId?, itemIds, title?, notes? } -> 201 (un solo borrador por persona)
 * - PATCH /api/patients/:id/budgets/:budgetId { title?, notes? } (solo borrador)
 * - POST /api/patients/:id/budgets/:budgetId/lines { lines } (precio, motivo, promoción
 *   y visitas previstas, por opción; solo borrador)
 * - POST /api/patients/:id/budgets/:budgetId/items[/remove] { itemIds, optionId? }
 * - POST /api/patients/:id/budgets/:budgetId/options/:optionId/duplicate|recommend|remove
 * - POST /api/patients/:id/budgets/:budgetId/deliver {} (imprimir y entregar)
 * - GET /api/patients/:id/budgets/:budgetId/send-preview · POST …/send { requestId? }
 * - POST /api/patients/:id/budgets/:budgetId/decision { optionId?, decisions, decidedByContactId?, decisionNote? }
 * - POST /api/patients/:id/budgets/:budgetId/cancel {}
 * - GET /api/patients/:id/next-step -> «Qué sigue» del plan
 * - PDF servidor: /api/patients/:id/financial-document-pdf?documentType=budget&documentId=
 *
 * Aquí solo tipos de vista y fetch: nunca se recalculan totales ni se
 * reinterpretan estados; el servidor es la fuente (totalCents/acceptedCents,
 * `stateText`).
 */
import { budgetAnswerText, type PatientGuide } from "@odentia/clinical"
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

/** Estados en los que todavía se puede anotar (o completar) la respuesta. */
export const BUDGET_ANSWERABLE_STATUSES: readonly string[] = ["presentado", "parcial", "pospuesto"]

/** Estados en los que el presupuesto se puede enviar (o reenviar). */
export const BUDGET_SENDABLE_STATUSES: readonly string[] = ["borrador", "presentado", "pospuesto", "parcial", "aceptado"]

export type PlanDecision =
  | "pendiente"
  | "aceptado"
  | "pospuesto"
  | "rechazado"
  | "reemplazado"
  | "no_elegida"

export interface Budget {
  id: string
  organizationId?: string
  patientId?: string
  planId: string
  budgetNumber: number
  revisionNumber?: number
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
  /** «Lo vio en el portal el …»: la última vez que lo abrió en el portal (ADR 0037). */
  seenInPortalAt?: string | null
  /** Hasta cuándo vale (AAAA-MM-DD). */
  validUntil?: string | null
  /** «Lo que le proponemos». */
  proposal?: string | null
  /** Hay «Lo que encontramos», sin decir qué: el texto solo llega por `presentation`. */
  hasFindings?: boolean
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
  /** La opción de la línea; el mismo tratamiento puede estar en varias. */
  optionId: string
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
  /** Rebaja de la línea frente a su tarifa (null si no baja): «{importe} menos que el precio normal». */
  lineDiscountCents: number | null
  currency: string
  decision: PlanDecision
  itemStatus: string
}

/** Una opción del presupuesto con su total (nunca sumado con las demás). */
export interface BudgetOption {
  id: string
  position: number
  /** «Opción A». */
  label: string
  /** Cómo la llama la clínica, a favor y a considerar. */
  name?: string | null
  pros?: string | null
  cons?: string | null
  isRecommended: boolean
  /** `pendiente`, `elegida` o `no_elegida`. */
  decision: string
  lineCount: number
  totalCents: number | null
  acceptedCents: number | null
  tariffTotalCents: number | null
  discountCents: number | null
}

export interface BudgetWithTotals extends Budget {
  items: BudgetLine[]
  options: BudgetOption[]
  /** Total de la opción que vale (la elegida o, mientras decide, la recomendada). */
  totalCents: number | null
  acceptedCents: number | null
  tariffTotalCents: number | null
  discountCents: number | null
  /** Espera la respuesta de quien decide: lo dice el servidor con su única regla, la pantalla no lo deduce. */
  awaitsAnswer: boolean
  /** El estado con su nombre de siempre («Por enviar», «Aceptó 2 de 3»…), del servidor. */
  stateText: string
}

/** La opción que vale: la elegida o, mientras decide, la recomendada. */
export function valueOption(budget: Pick<BudgetWithTotals, "options">): BudgetOption | null {
  return (
    budget.options.find((option) => option.decision === "elegida") ??
    budget.options.find((option) => option.isRecommended) ??
    budget.options[0] ??
    null
  )
}

/** Las líneas de una opción. */
export function optionLines(budget: Pick<BudgetWithTotals, "items">, optionId: string): BudgetLine[] {
  return budget.items.filter((line) => line.optionId === optionId)
}

/**
 * El estado de un presupuesto cuando solo se tiene su código (listas de otras
 * pantallas). Con el presupuesto completo, vale su `stateText`, que además dice
 * «Aceptó N de M».
 */
export function budgetStatusLabel(status: string): string {
  switch (status) {
    case "borrador":
      return "Por enviar"
    case "presentado":
      return "Enviado · espera respuesta"
    case "pospuesto":
      return "Lo está pensando"
    case "aceptado":
      return "Aceptó todo"
    case "parcial":
      return "Aceptó una parte"
    case "rechazado":
      return "No aceptó"
    case "sustituido":
      return "Reemplazado"
    case "cancelado":
      return "Anulado"
    default: {
      // Un estado nuevo nunca llega a pantalla como código crudo.
      const text = status.replace(/[_-]+/g, " ").trim()
      return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Sin estado"
    }
  }
}

/** Respuesta a un tratamiento del presupuesto: las mismas palabras que el estado. */
export function budgetAnswerLabel(decision: string | null | undefined): string {
  return budgetAnswerText(decision)
}

/** Decisión de un tratamiento del plan (separada de la ejecución clínica). */
export function planDecisionLabel(decision: string | null | undefined): string {
  if (decision === "pendiente" || decision == null) return "Por decidir"
  return budgetAnswerText(decision)
}

/**
 * Lo que se dice de un tratamiento en el Plan: su respuesta si ya respondió;
 * si no, en qué está su presupuesto («Por enviar», «Enviado · espera
 * respuesta») o que aún no tiene uno.
 */
export function itemStateText(
  item: Pick<PlanItem, "decision" | "budgetId">,
  budgetsById: Map<string, Pick<Budget, "status">>,
): string {
  if (item.decision !== "pendiente") return budgetAnswerText(item.decision)
  const budget = item.budgetId ? budgetsById.get(item.budgetId) : undefined
  if (!budget || budget.status === "cancelado") return "Sin presupuesto"
  return budgetStatusLabel(budget.status)
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
  planId?: string | null
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

/** Entregar el presupuesto al imprimirlo: lo entrega en mano. */
export function deliverBudgetApi(patientId: string, budgetId: string): Promise<{ data: Budget }> {
  return apiFetch<{ data: Budget }>(`${budgetsBase(patientId)}/${budgetId}/deliver`, {
    method: "POST",
    body: JSON.stringify({}),
  })
}

/** A quién le llega y por dónde saldría, sin enviar nada. */
export interface BudgetSendPreview {
  recipient: { contactId: string; name: string; relation: string }
  channel: "whatsapp" | "email" | null
  via: "respuesta" | "plantilla" | "correo" | null
  /** «Enviar por WhatsApp» o «Enviar por correo». */
  label: string | null
  /** Por qué no se puede enviar; imprimir y entregar sigue siendo la vía. */
  blocked: string | null
  /** El texto que recibe. */
  text: string
}

export function fetchBudgetSendPreview(
  patientId: string,
  budgetId: string,
): Promise<{ data: BudgetSendPreview }> {
  return apiFetch<{ data: BudgetSendPreview }>(`${budgetsBase(patientId)}/${budgetId}/send-preview`)
}

export interface SendBudgetResult {
  conversationId: string
  messageId: string
  status: "queued"
  channel: "whatsapp" | "email"
  via: "respuesta" | "plantilla" | "correo"
  recipientName: string
  deliveredBudget: boolean
}

/** Enviar por la regla de siempre: WhatsApp primero, correo si no. Si era borrador, lo entrega. */
export function sendBudgetApi(
  patientId: string,
  budgetId: string,
  body: { requestId: string },
): Promise<{ data: SendBudgetResult }> {
  return apiFetch<{ data: SendBudgetResult }>(`${budgetsBase(patientId)}/${budgetId}/send`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export interface AdjustBudgetLineBody {
  planItemId: string
  /** La opción de la línea; sin ella, el cambio vale para ese tratamiento en todas. */
  optionId?: string | null
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

/** Añade tratamientos del plan a un borrador (a una opción o a todas). */
export function addBudgetItemsApi(
  patientId: string,
  budgetId: string,
  itemIds: string[],
  optionId?: string | null,
): Promise<{ data: BudgetWithTotals }> {
  return apiFetch<{ data: BudgetWithTotals }>(`${budgetsBase(patientId)}/${budgetId}/items`, {
    method: "POST",
    body: JSON.stringify({ itemIds, ...(optionId ? { optionId } : {}) }),
  })
}

/** Quita tratamientos de un borrador (de una opción o de todas). */
export function removeBudgetItemsApi(
  patientId: string,
  budgetId: string,
  itemIds: string[],
  optionId?: string | null,
): Promise<{ data: BudgetWithTotals }> {
  return apiFetch<{ data: BudgetWithTotals }>(
    `${budgetsBase(patientId)}/${budgetId}/items/remove`,
    { method: "POST", body: JSON.stringify({ itemIds, ...(optionId ? { optionId } : {}) }) },
  )
}

/** «Duplicar como otra opción», marcar la recomendada o quitar una opción (solo borrador). */
export function budgetOptionApi(
  patientId: string,
  budgetId: string,
  optionId: string,
  action: "duplicate" | "recommend" | "remove",
): Promise<{ data: BudgetWithTotals }> {
  return apiFetch<{ data: BudgetWithTotals }>(
    `${budgetsBase(patientId)}/${budgetId}/options/${optionId}/${action}`,
    { method: "POST", body: JSON.stringify({}) },
  )
}

/** Lo que explica el presupuesto; `findings` es null si quien mira no lee la clínica. */
export interface BudgetPresentation {
  budgetId: string
  status: string
  findings: string | null
  hasFindings: boolean
  proposal: string | null
  validUntil: string | null
  options: Array<{ id: string; label: string; name: string | null; pros: string | null; cons: string | null }>
  lines: Array<{
    id: string
    optionId: string
    planItemId: string
    title: string
    /** El ajuste para este paciente; sin él vale el del servicio. */
    patientGuide: PatientGuide | null
    serviceGuide: PatientGuide | null
  }>
}

export interface BudgetPresentationBody {
  findings?: string | null
  proposal?: string | null
  validUntil?: string | null
  options?: Array<{ optionId: string; name?: string | null; pros?: string | null; cons?: string | null }>
  lines?: Array<{ lineId: string; patientGuide: PatientGuide | null }>
}

export function fetchBudgetPresentation(patientId: string, budgetId: string): Promise<{ data: BudgetPresentation }> {
  return apiFetch<{ data: BudgetPresentation }>(`${budgetsBase(patientId)}/${budgetId}/presentation`)
}

/** Solo en borrador: lo entregado no cambia (409 `BUDGET_STATUS`). */
export function updateBudgetPresentation(
  patientId: string,
  budgetId: string,
  body: BudgetPresentationBody,
): Promise<{ data: BudgetPresentation }> {
  return apiFetch<{ data: BudgetPresentation }>(`${budgetsBase(patientId)}/${budgetId}/presentation`, {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}

/** Documento PDF del servidor (mismo que se envía al paciente). */
export function budgetPdfUrl(patientId: string, budgetId: string): string {
  return `/api/patients/${patientId}/financial-document-pdf?documentType=budget&documentId=${budgetId}`
}

export interface DecideBudgetBody {
  /** La opción elegida; obligatoria si el presupuesto tiene más de una. */
  optionId?: string | null
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

/** Planes clínicos longitudinales del paciente (uno abierto; los demás, anteriores). */
export function fetchTreatmentPlans(
  patientId: string,
): Promise<{ data: TreatmentPlanWithStatus[] }> {
  return apiFetch<{ data: TreatmentPlanWithStatus[] }>(`/api/patients/${patientId}/plans`)
}

export interface PlanDetail {
  plan: TreatmentPlan
  status: string
  items: PlanItem[]
  budgetIds: string[]
}

export function fetchTreatmentPlanDetail(
  patientId: string,
  planId: string,
): Promise<{ data: PlanDetail }> {
  return apiFetch<{ data: PlanDetail }>(`/api/patients/${patientId}/plans/${planId}`)
}

/** «Qué sigue» del plan: frase y botón que decide el servidor. */
export interface PlanNextStep {
  kind: "enviar" | "agendar" | "respuesta" | "continuar" | "control" | "ninguno"
  text: string
  detail: string | null
  action: {
    label: string
    budgetId?: string
    planItemIds?: string[]
    serviceId?: string | null
    followUpId?: string
  } | null
}

export function fetchPlanNextStep(patientId: string): Promise<{ data: PlanNextStep }> {
  return apiFetch<{ data: PlanNextStep }>(`/api/patients/${patientId}/next-step`)
}

/** Lo que se invalida cuando cambia un presupuesto o el plan. */
export const PLAN_QUERY_KEYS = [
  "budgets",
  "budget",
  "treatment-plans",
  "treatment-plan",
  "plan-items",
  "patient-summary",
  "plan-next",
  "treatment-coordination",
  "treatment-journey",
] as const
