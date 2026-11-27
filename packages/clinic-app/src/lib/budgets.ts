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
import { budgetAnswerText, isLeftOut, moneyTotalsText, type PatientGuide } from "@odentia/clinical"
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
export const BUDGET_SENDABLE_STATUSES: readonly string[] = [
  "borrador",
  "presentado",
  "pospuesto",
  "parcial",
  "aceptado",
]

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
  /** Cuándo se entregó al paciente (impreso, enviado o mostrado en la atención). */
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
  /** Quién del equipo anotó la respuesta: sin firma, es su palabra. */
  decidedByName?: string | null
  /** Por dónde respondió: «enlace», «portal», «conversacion» o «clinica». */
  decidedVia?: string | null
  /** Firmó en la tablet quien decide (la firma no viaja: está en su hoja). */
  decisionSignedAt?: string | null
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
  /** Un total por moneda. Con dos, las cuatro cifras de abajo son nulas: entre monedas no se suma. */
  totals?: BudgetCurrencyTotal[]
  totalCents: number | null
  acceptedCents: number | null
  tariffTotalCents: number | null
  discountCents: number | null
}

/** El total de una moneda, del servidor: entre monedas nunca se suma ni se convierte. */
export interface BudgetCurrencyTotal {
  currency: string
  totalCents: number | null
  acceptedCents: number | null
  tariffTotalCents: number | null
  discountCents: number | null
}

/** Los totales de una opción o de un presupuesto: siempre al menos uno, el de su moneda. */
export function totalsOf(
  of: Pick<
    BudgetOption,
    "totals" | "totalCents" | "acceptedCents" | "tariffTotalCents" | "discountCents"
  >,
  currency: string,
): BudgetCurrencyTotal[] {
  if (of.totals?.length) return of.totals
  return [
    {
      currency,
      totalCents: of.totalCents,
      acceptedCents: of.acceptedCents,
      tariffTotalCents: of.tariffTotalCents,
      discountCents: of.discountCents,
    },
  ]
}

/** El presupuesto que quedó armado al firmar, como lo devuelve el cierre (`AssembledBudget`). */
export interface FinalizedBudget {
  id: string
  budgetNumber: number
  itemCount: number
  /** Un total por moneda; con dos, `totalCents` es nulo. */
  totals?: BudgetCurrencyTotal[] | Array<{ currency: string; totalCents: number | null }>
  totalCents: number | null
  currency: string
  added: number
  /** Cada opción con su total, de la misma lectura que arma el presupuesto. */
  options?: Array<{
    id: string
    position: number
    label: string
    name: string | null
    totals?: Array<{ currency: string; totalCents: number | null }>
    totalCents: number | null
  }>
}

/**
 * «Presupuesto listo: …» del cierre. Con caminos, cada uno con su total y unidos con «o»: nunca se
 * suman. Las cifras son las que trajo el cierre (QA del 27 nov): leerlas de otra consulta podía dar
 * las de antes de firmar, distintas de las que se envían. Sin `format` (aún sin el idioma), sin cifras.
 */
export function finalizedBudgetText(
  budget: FinalizedBudget,
  format: ((cents: number, currency: string) => string) | null,
): string {
  const options = [...(budget.options ?? [])].sort((a, b) => a.position - b.position)
  if (options.length > 1) {
    const count = options.length === 2 ? "dos" : options.length === 3 ? "tres" : String(options.length)
    const words = options.map((option) => {
      const label = option.name?.trim() || option.label
      if (!format) return label
      const totals = option.totals?.length ? option.totals : [{ currency: budget.currency, totalCents: option.totalCents }]
      return `${label} ${moneyTotalsText(totals, format, "con un precio por definir")}`
    })
    return `Presupuesto listo con ${count} opciones: ${words.join(" o ")}. Nunca se suman.`
  }
  const treatments = budget.itemCount === 1 ? "1 tratamiento" : `${budget.itemCount} tratamientos`
  const totals = budget.totals?.length ? budget.totals : [{ currency: budget.currency, totalCents: budget.totalCents }]
  return format
    ? `Presupuesto listo: ${treatments} por ${moneyTotalsText(totals, format, "un precio por definir")}`
    : `Presupuesto listo: ${treatments}`
}

export interface BudgetWithTotals extends Budget {
  items: BudgetLine[]
  options: BudgetOption[]
  /** Un total por moneda de la opción que vale. Con dos, las cuatro cifras de abajo son nulas. */
  totals?: BudgetCurrencyTotal[]
  /** Total de la opción que vale (la elegida o, mientras decide, la recomendada). */
  totalCents: number | null
  acceptedCents: number | null
  tariffTotalCents: number | null
  discountCents: number | null
  /** Espera la respuesta de quien decide: lo dice el servidor con su única regla, la pantalla no lo deduce. */
  awaitsAnswer: boolean
  /** El estado con su nombre de siempre («Por enviar», «Aceptó 2 de 3»…), del servidor. */
  stateText: string
  /**
   * Lo que dicen las pantallas («Eligió la opción A» con una opción elegida), del servidor, igual
   * que la Historia (`budgetChoiceText`). Opcional mientras dura un despliegue: sin él, `stateText`.
   */
  choiceText?: string
  /**
   * Quien mira puede cambiarlo, enviarlo o anularlo: el odontólogo lee los de sus
   * colegas, pero solo cambia lo suyo. Lo dice el servidor.
   */
  canChange?: boolean
  /**
   * Si le llegó, con lo que dice su mensaje: «Enviado» hasta que WhatsApp lo confirma,
   * «Entregado» o «Leído» con su acuse y «No llegó» si lo rechazó. Nulo en un borrador.
   * Lo dice el servidor; opcional mientras dura un despliegue.
   */
  delivery?: BudgetDelivery | null
}

/** La entrega de un presupuesto, como la dice el servidor (`budget-delivery.ts`). */
export interface BudgetDelivery {
  state: "en_mano" | "enviado" | "entregado" | "leido" | "no_llego"
  channel: "whatsapp" | "email" | null
  at: string
  /** «Entregado el 27 nov», «Enviado por WhatsApp el 27 nov», «No llegó por WhatsApp · enviado el 27 nov». */
  text: string
  /** Por qué no llegó y qué hacer. */
  problem: string | null
  /** Solo por qué no llegó. */
  reason?: string | null
  /** Falso si todos sus envíos fallaron: no le llegó. */
  reached: boolean
  /** El estado de lo entregado que espera respuesta, dicho con su entrega («Enviado · espera respuesta», «No le llegó»). */
  label: string
}

/**
 * El estado de un presupuesto en las pantallas de la clínica: el de siempre, salvo lo
 * entregado que espera respuesta, que dice si le llegó («Enviado · espera respuesta»
 * mientras WhatsApp no lo confirma, «No le llegó» si lo rechazó).
 */
export function budgetStateWithDelivery(budget: Pick<BudgetWithTotals, "status" | "stateText" | "delivery">): string {
  return budget.status === "presentado" && budget.delivery ? budget.delivery.label : budget.stateText
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

/**
 * El monto de la fila de un presupuesto en Documentos: ya respondido (aceptado o parcial), lo que
 * aceptó, con «aceptó» delante; si no, el total de la opción que vale (verificación del 18 nov, 10:
 * «Eligió la opción A» iba junto al total de la opción, S/ 1,550, cuando aceptó S/ 650).
 */
export function budgetRowAmount(
  budget: Pick<
    BudgetWithTotals,
    "status" | "options" | "currency" | "totals" | "totalCents" | "acceptedCents" | "tariffTotalCents" | "discountCents"
  >,
): { accepted: boolean; totals: Array<{ currency: string; totalCents: number | null }> } {
  const totals = totalsOf(valueOption(budget) ?? budget, budget.currency)
  const accepted = budget.status === "aceptado" || budget.status === "parcial"
  if (!accepted) return { accepted, totals }
  return { accepted, totals: totals.map((row) => ({ currency: row.currency, totalCents: row.acceptedCents })) }
}

/** Las líneas de una opción. */
export function optionLines(
  budget: Pick<BudgetWithTotals, "items">,
  optionId: string,
): BudgetLine[] {
  return budget.items.filter((line) => line.optionId === optionId)
}

/** La línea espera respuesta: nadie la respondió o lo está pensando (lo demás no se reescribe). */
export function lineAwaitsAnswer(line: Pick<BudgetLine, "decision">): boolean {
  return line.decision === "pendiente" || line.decision === "pospuesto"
}

type CommonLine = Pick<
  BudgetLine,
  "planItemId" | "optionId" | "priceCents" | "billingMode" | "sessionsPlanned" | "promotionId"
>

/**
 * Lo común a todas las opciones: el mismo tratamiento en cada una, con el mismo
 * precio, cobro, sesiones y promoción. Es la regla del servidor
 * (`commonPlanItems` en servicios), que la aplica al anotar: aquí solo decide
 * qué se pregunta sin elegir camino.
 */
export function commonPlanItemIds(lines: readonly CommonLine[], optionCount: number): Set<string> {
  const byItem = new Map<string, CommonLine[]>()
  for (const line of lines) byItem.set(line.planItemId, [...(byItem.get(line.planItemId) ?? []), line])
  const out = new Set<string>()
  for (const [planItemId, own] of byItem) {
    if (new Set(own.map((line) => line.optionId)).size !== optionCount) continue
    const [first] = own
    if (
      first &&
      own.every(
        (line) =>
          line.priceCents === first.priceCents &&
          line.billingMode === first.billingMode &&
          line.sessionsPlanned === first.sessionsPlanned &&
          line.promotionId === first.promotionId,
      )
    ) {
      out.add(planItemId)
    }
  }
  return out
}

/** Un presupuesto con caminos: lo común una vez y lo propio de cada camino. */
export interface BudgetPaths {
  /** Lo que va en todos los caminos, un tratamiento una vez. */
  common: BudgetLine[]
  /** Cada camino (opción), en su orden, con lo que solo está en él. */
  paths: Array<{ option: BudgetOption; own: BudgetLine[] }>
  /** Lo que es de algún camino, un tratamiento una vez. */
  exclusive: BudgetLine[]
}

/**
 * Reparte las líneas en lo común y lo de cada camino. Un tratamiento que está en
 * varias opciones cuenta una vez, con la línea de la opción que vale (como el
 * servidor al anotar sin elegir camino).
 */
export function budgetPaths(budget: Pick<BudgetWithTotals, "items" | "options">): BudgetPaths {
  const options = [...budget.options].sort((a, b) => a.position - b.position)
  const common = commonPlanItemIds(budget.items, options.length)
  const valued = valueOption(budget)?.id ?? null
  const unique = new Map<string, BudgetLine>()
  for (const line of budget.items) {
    const seen = unique.get(line.planItemId)
    if (!seen || (seen.optionId !== valued && line.optionId === valued)) unique.set(line.planItemId, line)
  }
  const lines = [...unique.values()]
  return {
    common: lines.filter((line) => common.has(line.planItemId)),
    paths: options.map((option) => ({
      option,
      own: budget.items.filter((line) => line.optionId === option.id && !common.has(line.planItemId)),
    })),
    exclusive: lines.filter((line) => !common.has(line.planItemId)),
  }
}

/** La respuesta marcada de un tratamiento en «¿Qué respondió?»: vacía mientras no se marca. */
export interface AnswerMark {
  planItemId: string
  decision: "aceptado" | "pospuesto" | "rechazado" | ""
}

/**
 * Las marcas del panel puestas al día con el presupuesto de ahora (QA del 16 nov, Q1). El panel se
 * abre con el presupuesto que tenía la pantalla; si después entra un tratamiento (lo indicado
 * entra solo al borrador) o sale otro, lo marcado se conserva, lo nuevo llega con su marca de
 * partida y lo que ya no está se va. Sin esto la línea nueva viajaba sin respuesta y el servidor
 * rechazaba el guardado.
 */
export function syncAnswerMarks(
  marked: readonly AnswerMark[],
  wanted: readonly AnswerMark[],
): { marks: AnswerMark[]; added: string[]; changed: boolean } {
  const before = new Map(marked.map((entry) => [entry.planItemId, entry]))
  const added = wanted.filter((entry) => !before.has(entry.planItemId)).map((entry) => entry.planItemId)
  const marks = wanted.map((entry) => before.get(entry.planItemId) ?? entry)
  const changed =
    added.length > 0 ||
    marks.length !== marked.length ||
    marks.some((entry, index) => entry.planItemId !== marked[index]?.planItemId)
  return { marks, added, changed }
}

/** Lo que lleva una revisión, en el orden en que se muestra. */
export interface RevisionScope {
  /** Cada tratamiento una vez: es lo que se manda (`itemIds`). */
  lines: BudgetLine[]
  /**
   * Sin camino elegido, un grupo por los caminos en que va cada tratamiento: el
   * de todos primero, después cada camino con lo suyo y al final lo que va en
   * algunos. Con un camino elegido o una sola opción, un solo grupo sin caminos.
   */
  groups: Array<{ options: BudgetOption[]; lines: BudgetLine[] }>
}

/**
 * Lo que lleva la revisión. Sin camino elegido, todos los caminos: nadie
 * eligió, y el servidor quita el camino del que no llega nada suyo
 * (`reviseBudget` en servicios, ADR 0153). Con uno elegido (o una sola
 * opción), solo ese.
 */
export function revisionScope(budget: Pick<BudgetWithTotals, "items" | "options">): RevisionScope {
  const choosing =
    budget.options.length > 1 && !budget.options.some((option) => option.decision === "elegida")
  if (!choosing) {
    const value = valueOption(budget)
    const lines = value ? optionLines(budget, value.id) : budget.items
    return { lines, groups: [{ options: [], lines }] }
  }
  const options = [...budget.options].sort((a, b) => a.position - b.position)
  // Cada tratamiento se manda una vez, aunque vaya en varios caminos (también
  // con otro precio en cada uno: el servidor lo deja en cada camino con lo suyo).
  // Se muestra bajo los caminos en que va, para que desmarcarlo diga de dónde sale.
  const valued = valueOption(budget)?.id ?? null
  const byItem = new Map<string, { line: BudgetLine; in: Set<string> }>()
  for (const option of options) {
    for (const line of optionLines(budget, option.id)) {
      const seen = byItem.get(line.planItemId)
      if (!seen) byItem.set(line.planItemId, { line, in: new Set([option.id]) })
      else {
        seen.in.add(option.id)
        if (option.id === valued) seen.line = line
      }
    }
  }
  const groups = new Map<string, { options: BudgetOption[]; lines: BudgetLine[] }>()
  for (const { line, in: inOptions } of byItem.values()) {
    const own = options.filter((option) => inOptions.has(option.id))
    const key = own.map((option) => option.id).join("|")
    const group = groups.get(key) ?? { options: own, lines: [] }
    group.lines.push(line)
    groups.set(key, group)
  }
  const rank = (group: { options: BudgetOption[] }) =>
    group.options.length === options.length ? 0 : group.options.length === 1 ? 1 : 2
  const ordered = [...groups.values()].sort(
    (a, b) => rank(a) - rank(b) || (a.options[0]?.position ?? 0) - (b.options[0]?.position ?? 0),
  )
  return { lines: ordered.flatMap((group) => group.lines), groups: ordered }
}

/**
 * Las opciones que la revisión quitaría con lo marcado (`sent`), con la regla
 * del servidor (`reviseBudget`): sin camino elegido, sale la opción de la que
 * se desmarcó todo lo propio suyo; la que solo lleva lo común, si no va nada
 * suyo. Si salieran todas, el servidor deja la primera: no se avisa nada.
 */
export function revisionDroppedOptions(
  budget: Pick<BudgetWithTotals, "items" | "options">,
  sent: ReadonlySet<string>,
): Set<string> {
  const choosing =
    budget.options.length > 1 && !budget.options.some((option) => option.decision === "elegida")
  if (!choosing) return new Set()
  const common = commonPlanItemIds(budget.items, budget.options.length)
  const dropped = budget.options.filter((option) => {
    const mine = optionLines(budget, option.id)
    const own = mine.filter((line) => !common.has(line.planItemId))
    return !(own.length > 0 ? own : mine).some((line) => sent.has(line.planItemId))
  })
  return dropped.length === budget.options.length
    ? new Set()
    : new Set(dropped.map((option) => option.id))
}

/** Lo que dice la pantalla del estado de un presupuesto completo: las mismas palabras que la Historia. */
export function budgetChoiceWords(budget: Pick<BudgetWithTotals, "choiceText" | "stateText">): string {
  return budget.choiceText ?? budget.stateText
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
      return "Entregado · espera respuesta"
    case "pospuesto":
      return "Lo piensa"
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
 * si no, en qué está su presupuesto («Por enviar», «Entregado · espera
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
  options: Array<{
    id: string
    label: string
    name: string | null
    pros: string | null
    cons: string | null
    /** La que verá marcada el paciente: «Lo que le proponemos» no la cambia. */
    isRecommended: boolean
  }>
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
  options?: Array<{
    optionId: string
    name?: string | null
    pros?: string | null
    cons?: string | null
  }>
  lines?: Array<{ lineId: string; patientGuide: PatientGuide | null }>
}

export function fetchBudgetPresentation(
  patientId: string,
  budgetId: string,
): Promise<{ data: BudgetPresentation }> {
  return apiFetch<{ data: BudgetPresentation }>(
    `${budgetsBase(patientId)}/${budgetId}/presentation`,
  )
}

/** Solo en borrador: lo entregado no cambia (409 `BUDGET_STATUS`). */
export function updateBudgetPresentation(
  patientId: string,
  budgetId: string,
  body: BudgetPresentationBody,
): Promise<{ data: BudgetPresentation }> {
  return apiFetch<{ data: BudgetPresentation }>(
    `${budgetsBase(patientId)}/${budgetId}/presentation`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
    },
  )
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
  /** Se le mostró en la atención: un presupuesto por entregar queda entregado al anotar. */
  inPerson?: boolean
  /** Firmó en la tablet quien decide: sus trazos. */
  signature?: { strokes: number[][][] } | null
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
  kind: "enviar" | "agendar" | "respuesta" | "continuar" | "reservado" | "control" | "cerrar" | "sin_objeto" | "suspendido" | "ninguno"
  text: string
  detail: string | null
  action: {
    label: string
    budgetId?: string
    planItemIds?: string[]
    serviceId?: string | null
    followUpId?: string
    appointmentId?: string
    /** Varios controles en la misma cita. */
    followUpIds?: string[]
    /** Desde qué día (`YYYY-MM-DD`) se busca hora, y por qué (lo dice el cajón). */
    date?: string
    note?: string
    /** «Sumar a su cita del 10 nov»: la cita que ya tiene. */
    join?: { appointmentId: string; label: string }
    /** La cita sin objeto: su versión y lo aceptado que podría ir en ella. */
    appointmentVersion?: number
    appointmentStartsAt?: string
    reuse?: { planItemId: string; title: string }
    /** La sesión siguiente: quien hizo la anterior y la sede de esa atención, primero en la reserva. */
    professionalUserId?: string
    professionalName?: string | null
    branchId?: string
  } | null
  /** Lo aceptado sin empezar que también falta agendar cuando gana la sesión de un tratamiento empezado. */
  alsoToSchedule?: string[]
  /** Un aviso que no frena, en su propio renglón (la cita que se atendió sin registrar lo hecho). */
  notice?: string | null
}

export function fetchPlanNextStep(patientId: string): Promise<{ data: PlanNextStep }> {
  return apiFetch<{ data: PlanNextStep }>(`/api/patients/${patientId}/next-step`)
}

/** Todo lo que sigue, en una lista (el Resumen): la misma regla, con el control vencido primero. */
export function fetchPlanNextSteps(patientId: string): Promise<{ data: PlanNextStep[] }> {
  return apiFetch<{ data: PlanNextStep[] }>(`/api/patients/${patientId}/next-steps`)
}

/** La misma lista, con lo de una atención primero: «Lo que sigue» de la atención firmada. */
export function fetchEncounterNextSteps(patientId: string, encounterId: string): Promise<{ data: PlanNextStep[] }> {
  return apiFetch<{ data: PlanNextStep[] }>(`/api/patients/${patientId}/encounters/${encounterId}/next-steps`)
}

/** Lo que cuenta el servidor como por ejecutar (`TO_EXECUTE_STATUSES`) y no quedó fuera por la persona. */
const TO_EXECUTE = new Set(["pendiente", "programado", "en_curso"])

/**
 * Lo que una atención deja por ejecutar, sin contar como dos los caminos que se excluyen (QA del 22 nov,
 * H12: «2 por ejecutar» con dos caminos de los que solo uno se hará). `pending` es lo que cuenta el
 * servidor; los tratamientos de un presupuesto con caminos por elegir salen de ahí y quedan como una
 * elección por presupuesto, con cuántos caminos tiene (`choices`). `competing`: esos tratamientos, que
 * tampoco se cuentan como «indicados hoy» uno por uno (QA del 23 nov, verificador 2).
 */
export function pendingTreatmentCounts(
  pending: number,
  items: ReadonlyArray<Pick<PlanItem, "id" | "status" | "path"> & { decisionStatus?: string | null }>,
): { toExecute: number; choices: number[]; competing: Set<string> } {
  const seen = new Set<string>()
  const paths = new Map<string, number>()
  const competing = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    const path = item.path
    if (!path || path.chosen || path.pathCount < 2 || !TO_EXECUTE.has(item.status) || isLeftOut(item.decisionStatus)) continue
    competing.add(item.id)
    paths.set(path.budgetId, path.pathCount)
  }
  return { toExecute: Math.max(0, pending - competing.size), choices: [...paths.values()], competing }
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

/** Lo dictado que cambia el plan o su presupuesto al confirmarse: el plan, los caminos, lo hecho hoy, la cita. */
const DICTATION_PLAN_KINDS = new Set(["plan", "procedimiento", "cita", "presupuesto"])

/**
 * Lo que se vuelve a leer al confirmar algo dictado. Lo que toca el plan vuelve a leer todo lo del plan:
 * confirmar los dos caminos abre un plan nuevo y el bloque Plan, que lee los planes vigentes, seguía
 * diciendo «Todavía no hay tratamientos por hacer» hasta recargar (QA del 22 nov, H8). Lo demás, solo
 * lo que se indicó.
 */
export function planKeysAfterDictation(kind: string): readonly string[] {
  return DICTATION_PLAN_KINDS.has(kind) ? PLAN_QUERY_KEYS : ["plan-items"]
}

/**
 * Lo que cambia en la atención abierta cuando la persona responde: lo que no
 * aceptó o no eligió deja de pedir consentimiento y de contar por ejecutar.
 */
export const ANSWER_ENCOUNTER_KEYS = ["encounter", "consent-needs", "encounter-closing"] as const

/**
 * Lo que se vuelve a leer al indicar un tratamiento en la atención. Lo indicado entra solo al
 * borrador, así que el presupuesto también cambió: la tarjeta de cada opción lee su detalle
 * (`budget`) y sin esto decía el total de antes (QA del 16 nov, Q4).
 */
export const INDICATED_QUERY_KEYS: readonly string[] = PLAN_QUERY_KEYS

/**
 * Lo que se vuelve a leer tras «Armarlo ahora»: el plan, «Qué sigue» y el detalle de la atención,
 * de donde sale lo indicado hoy con su presupuesto (QA del 16 nov, Q3).
 */
export const ASSEMBLED_QUERY_KEYS: readonly string[] = [...PLAN_QUERY_KEYS, "next-steps", ...ANSWER_ENCOUNTER_KEYS]
