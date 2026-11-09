/**
 * Anular una atención y el presupuesto que salió de ella: una sola regla, la
 * que lee el diálogo antes de confirmar (`getEncounterVoidPreview`) y la que
 * aplica `voidEncounter` con el plan tomado. Antes, cualquier tratamiento
 * presupuestado frenaba la anulación, aunque el presupuesto nunca se hubiera
 * entregado, y sin decir dónde se resolvía.
 *
 * Por presupuesto en pie que lleva algo indicado en esta atención:
 * - Sin entregar: se anula con la atención; si además lleva tratamientos de
 *   otras atenciones, solo se le quitan los de esta.
 * - Entregado: se anula con la atención si quien anula lo confirma. Si ya tiene
 *   una respuesta (lo está pensando o aceptó) y lleva tratamientos de otras
 *   atenciones, no se anula entero: se revisa sin lo de esta.
 * - Frena lo que no se deshace: un cobro vigente, algo ya hecho en otra
 *   atención, la firma de quien decide o una revisión por enviar.
 *
 * La autoridad es la de quien lleva la atención, sobre lo indicado en ella: un
 * presupuesto que solo lleva eso se anula sin la regla de «lo propio» del
 * presupuesto; uno que lleva tratamientos de otras atenciones, con ella.
 */
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import {
  appointmentPlanItem,
  encounterPlanItem,
  encounterProcedure,
  patientCharge,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentPlan,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { and, asc, eq, gte, inArray, isNotNull, isNull, ne, notInArray } from "drizzle-orm"
import {
  BUDGET_STATUSES_VOIDED_WITH_ENCOUNTER,
  cancelBudgetWithEncounter,
  isProfessional,
  lockPlan,
  ownBudgetOf,
  removeBudgetItems,
} from "./budgets.js"
import { ServiceError } from "./errors.js"
import { productHooks } from "./products.js"

/** Lo que no se deshace al anular la atención, con lo que hace falta para decirlo. */
export type EncounterVoidBlock =
  /** Caja cobró alguno de sus tratamientos: el cobro se anula en la cuenta de la persona. */
  | { kind: "cobro"; treatments: string[] }
  /** Alguno ya se hizo en otra atención. */
  | { kind: "hecho"; treatments: string[] }
  /** Quien decide firmó que lo acepta. */
  | { kind: "firma"; signedAt: string; signerName: string | null }
  /** Ya respondió y lleva tratamientos de otras atenciones: se revisa sin lo de esta. */
  | { kind: "otros"; others: number }
  /** Lleva tratamientos de otras atenciones y lo preparó otro profesional. */
  | { kind: "ajeno"; others: number }
  /** Tiene una revisión por enviar: se envía o se anula en el presupuesto. */
  | { kind: "revision" }

export interface EncounterVoidBudget {
  id: string
  budgetNumber: number
  status: string
  /** Se le entregó: anularlo lo confirma quien anula la atención. */
  delivered: boolean
  presentedAt: string | null
  decidedAt: string | null
  /** `anula`: se anula entero; `quita`: se le quitan los de esta atención; `frena`: ver `blocks`. */
  effect: "anula" | "quita" | "frena"
  /** Lo indicado en esta atención que lleva (nombre y sitio). */
  treatments: string[]
  /** Cuántos tratamientos de otras atenciones lleva: si se anula entero, vuelven al plan sin presupuesto. */
  others: number
  blocks: EncounterVoidBlock[]
  /** Citas por venir que traen lo de esta atención: no se cancelan solas. */
  appointments: Array<{ id: string; startsAt: string }>
}

export interface EncounterVoidPreview {
  budgets: EncounterVoidBudget[]
  /** Algo no se deshace: no se puede anular todavía. */
  blocked: boolean
  /** Lo entregado que se anula con la atención: `voidEncounter` lo recibe tal cual como confirmado. */
  confirm: Array<{ id: string; status: string }>
}

/** Lo cerrado ya no se anula ni se presupuesta. */
const CLOSED_ITEM = ["cancelado", "reemplazado"]
/** Lo que no se aceptó o no se eligió ya no compromete nada: el presupuesto queda como constancia. */
const SETTLED_DECISION = ["rechazado", "no_elegida", "reemplazado"]

/**
 * Qué pasa con cada presupuesto al anular la atención. Sin efectos; con
 * `lock`, toma antes el plan de cada tratamiento (el mismo candado de anotar la
 * respuesta y de cobrar) para que lo leído no cambie hasta terminar.
 */
export async function encounterVoidBudgets(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
  opts: { actorUserId: string; memberRole?: string; seesCharges?: boolean; lock?: boolean },
): Promise<EncounterVoidPreview> {
  if (opts.lock) {
    // Antes de leer: lo que otro presupueste, responda o cobre mientras tanto espera a que termine.
    const plans = await tx
      .select({ id: treatmentPlan.id })
      .from(treatmentPlan)
      .where(and(eq(treatmentPlan.organizationId, orgId), eq(treatmentPlan.patientId, patientId)))
      .orderBy(asc(treatmentPlan.id))
    for (const plan of plans) await lockPlan(tx, orgId, patientId, plan.id)
  }
  const indicated = await tx
    .select({ budgetId: treatmentPlanItem.budgetId })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.sourceEncounterId, encounterId),
        isNotNull(treatmentPlanItem.budgetId),
        notInArray(treatmentPlanItem.status, CLOSED_ITEM),
        notInArray(treatmentPlanItem.decisionStatus, SETTLED_DECISION),
      ),
    )
  if (indicated.length === 0) return { budgets: [], blocked: false, confirm: [] }
  const budgetIds = [...new Set(indicated.map((row) => row.budgetId!))]
  const budgets = await tx
    .select()
    .from(treatmentBudget)
    .where(
      and(
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
        inArray(treatmentBudget.id, budgetIds),
        inArray(treatmentBudget.status, [...BUDGET_STATUSES_VOIDED_WITH_ENCOUNTER]),
      ),
    )
    .orderBy(asc(treatmentBudget.budgetNumber), asc(treatmentBudget.revisionNumber))
  if (budgets.length === 0) return { budgets: [], blocked: false, confirm: [] }
  const liveIds = budgets.map((budget) => budget.id)
  const lines = await tx
    .selectDistinct({
      budgetId: treatmentBudgetItem.budgetId,
      planItemId: treatmentBudgetItem.planItemId,
    })
    .from(treatmentBudgetItem)
    .where(
      and(
        eq(treatmentBudgetItem.organizationId, orgId),
        inArray(treatmentBudgetItem.budgetId, liveIds),
      ),
    )
  const allItemIds = [...new Set(lines.map((line) => line.planItemId))]
  const items = allItemIds.length
    ? await tx
        .select()
        .from(treatmentPlanItem)
        .where(
          and(
            eq(treatmentPlanItem.organizationId, orgId),
            inArray(treatmentPlanItem.id, allItemIds),
          ),
        )
    : []
  const itemById = new Map(items.map((item) => [item.id, item]))
  const charged = allItemIds.length
    ? await tx
        .selectDistinct({ planItemId: patientCharge.planItemId })
        .from(patientCharge)
        .where(
          and(
            eq(patientCharge.organizationId, orgId),
            eq(patientCharge.patientId, patientId),
            inArray(patientCharge.planItemId, allItemIds),
            isNull(patientCharge.voidedAt),
          ),
        )
    : []
  const chargedIds = new Set(charged.map((row) => row.planItemId))
  // Lo hecho en otra atención: lo de esta se anula con ella y vuelve a quedar pendiente.
  const doneElsewhere = allItemIds.length
    ? await tx
        .selectDistinct({ planItemId: encounterProcedure.planItemId })
        .from(encounterProcedure)
        .where(
          and(
            eq(encounterProcedure.organizationId, orgId),
            inArray(encounterProcedure.planItemId, allItemIds),
            isNull(encounterProcedure.voidedAt),
            ne(encounterProcedure.encounterId, encounterId),
          ),
        )
    : []
  const doneIds = new Set(doneElsewhere.map((row) => row.planItemId))
  // Lo hecho aquí (con su sesión, o dado por realizado al traerlo la cita) se
  // deshace al anular (`voidProcedureRow`, `undoCompletionsOf`): no frena.
  const completedHere = allItemIds.length
    ? await tx
        .select({ planItemId: encounterPlanItem.planItemId })
        .from(encounterPlanItem)
        .where(
          and(
            eq(encounterPlanItem.organizationId, orgId),
            eq(encounterPlanItem.encounterId, encounterId),
            inArray(encounterPlanItem.planItemId, allItemIds),
          ),
        )
    : []
  const proceduresHere = allItemIds.length
    ? await tx
        .selectDistinct({ planItemId: encounterProcedure.planItemId })
        .from(encounterProcedure)
        .where(
          and(
            eq(encounterProcedure.organizationId, orgId),
            eq(encounterProcedure.encounterId, encounterId),
            inArray(encounterProcedure.planItemId, allItemIds),
            isNull(encounterProcedure.voidedAt),
          ),
        )
    : []
  const hereIds = new Set([
    ...completedHere.map((row) => row.planItemId),
    ...proceduresHere.map((row) => row.planItemId),
  ])
  for (const item of items) {
    if (item.status === "realizado" && !hereIds.has(item.id)) doneIds.add(item.id)
  }
  const revisions = await tx
    .select({ supersedes: treatmentBudget.supersedesBudgetId })
    .from(treatmentBudget)
    .where(
      and(
        eq(treatmentBudget.organizationId, orgId),
        inArray(treatmentBudget.supersedesBudgetId, liveIds),
        eq(treatmentBudget.status, "borrador"),
      ),
    )
  const withRevision = new Set(revisions.map((row) => row.supersedes))
  const own = isProfessional(opts.memberRole)
    ? new Set(
        (
          await tx
            .select({ id: treatmentBudget.id })
            .from(treatmentBudget)
            .where(
              and(
                eq(treatmentBudget.organizationId, orgId),
                inArray(treatmentBudget.id, liveIds),
                ownBudgetOf(treatmentBudget, opts.actorUserId),
              ),
            )
        ).map((row) => row.id),
      )
    : null
  const site = (await productHooks(tx, orgId)).site
  const name = (id: string) => {
    const item = itemById.get(id)
    if (!item) return ""
    const where = site.words(item, "short")
    return where ? `${item.title} · ${where}` : item.title
  }
  const hereItemIds = new Set(
    items
      .filter(
        (item) =>
          item.sourceEncounterId === encounterId &&
          !CLOSED_ITEM.includes(item.status) &&
          !SETTLED_DECISION.includes(item.decisionStatus),
      )
      .map((item) => item.id),
  )
  const upcoming = hereItemIds.size
    ? await tx
        .selectDistinct({
          id: appointment.id,
          startsAt: appointment.startsAt,
          planItemId: appointmentPlanItem.planItemId,
        })
        .from(appointmentPlanItem)
        .innerJoin(
          appointment,
          and(
            eq(appointment.organizationId, appointmentPlanItem.organizationId),
            eq(appointment.id, appointmentPlanItem.appointmentId),
          ),
        )
        .where(
          and(
            eq(appointmentPlanItem.organizationId, orgId),
            inArray(appointmentPlanItem.planItemId, [...hereItemIds]),
            inArray(appointment.status, ["programada", "confirmada"]),
            gte(appointment.startsAt, new Date()),
          ),
        )
        .orderBy(asc(appointment.startsAt))
    : []

  const out: EncounterVoidBudget[] = []
  for (const budget of budgets) {
    const ids = [
      ...new Set(
        lines.filter((line) => line.budgetId === budget.id).map((line) => line.planItemId),
      ),
    ]
    const here = ids.filter((id) => hereItemIds.has(id))
    if (here.length === 0) continue
    // Lo de otras atenciones que sigue en pie. Lo de esta que no aceptó o no
    // eligió no es «otro»: se cancela con ella y queda en el presupuesto como constancia.
    const others = ids.filter((id) => {
      const item = itemById.get(id)
      return !!item && item.sourceEncounterId !== encounterId && !CLOSED_ITEM.includes(item.status)
    }).length
    const delivered = budget.status !== "borrador"
    const blocks: EncounterVoidBlock[] = []
    let effect: EncounterVoidBudget["effect"] = "anula"
    if (budget.status === "borrador" && budget.supersedesBudgetId) {
      blocks.push({ kind: "revision" })
    } else if (!delivered && others > 0) {
      // Sin entregar y con otras atenciones: se quitan los de esta y lo demás sigue ahí.
      effect = "quita"
    } else {
      if (withRevision.has(budget.id)) blocks.push({ kind: "revision" })
      if (budget.decisionSignedAt) {
        blocks.push({
          kind: "firma",
          signedAt: budget.decisionSignedAt.toISOString(),
          signerName: budget.decisionSignature?.signerName ?? budget.acceptedByName ?? null,
        })
      }
      if (others > 0 && budget.status !== "presentado" && !budget.decisionSignedAt)
        blocks.push({ kind: "otros", others })
      if (others > 0 && budget.status === "presentado" && own && !own.has(budget.id))
        blocks.push({ kind: "ajeno", others })
      const charges = ids.filter((id) => chargedIds.has(id))
      // Qué cobró caja solo lo lee quien ve la caja: a los demás, que hay un cobro.
      if (charges.length > 0)
        blocks.push({ kind: "cobro", treatments: opts.seesCharges ? charges.map(name) : [] })
      const done = ids.filter((id) => doneIds.has(id))
      if (done.length > 0) blocks.push({ kind: "hecho", treatments: done.map(name) })
    }
    if (blocks.length > 0) effect = "frena"
    out.push({
      id: budget.id,
      budgetNumber: budget.budgetNumber,
      status: budget.status,
      delivered,
      presentedAt: budget.presentedAt?.toISOString() ?? null,
      decidedAt: budget.decidedAt?.toISOString() ?? null,
      effect,
      treatments: here.map(name),
      others,
      blocks,
      appointments: [
        ...new Map(
          upcoming
            .filter((row) => here.includes(row.planItemId))
            .map((row) => [row.id, { id: row.id, startsAt: row.startsAt.toISOString() }] as const),
        ).values(),
      ],
    })
  }
  return {
    budgets: out,
    blocked: out.some((budget) => budget.effect === "frena"),
    confirm: out
      .filter((budget) => budget.delivered && budget.effect === "anula")
      .map((budget) => ({ id: budget.id, status: budget.status })),
  }
}

/** Lo que dice el rechazo cuando algo no se deshace: lo mismo que el diálogo, en una línea. */
function blockedMessage(budget: EncounterVoidBudget): string {
  const block = budget.blocks[0]
  const which = `el presupuesto N.º ${budget.budgetNumber}`
  switch (block?.kind) {
    case "cobro":
      return `No se puede anular todavía: caja ya cobró ${block.treatments.length > 0 ? block.treatments.join(", ") : "un tratamiento"} del presupuesto N.º ${budget.budgetNumber}. Hay que anular ese cobro primero.`
    case "hecho":
      return `No se puede anular todavía: ${block.treatments.join(", ")}, del presupuesto N.º ${budget.budgetNumber}, ya se hizo en otra atención. Si esta atención no va, fírmala dejando en la evolución lo que pasó.`
    case "firma":
      return `No se puede anular: quien decide firmó que acepta ${which}. Si esta atención no va, fírmala dejando en la evolución lo que pasó.`
    case "otros":
      return `No se puede anular todavía: ${which} ya tiene respuesta y lleva otros tratamientos. Revísalo sin lo de esta atención.`
    case "ajeno":
      return `No se puede anular todavía: ${which} lleva tratamientos de otros profesionales y lo preparó otra persona.`
    case "revision":
      return `No se puede anular todavía: ${which} tiene una revisión por enviar. Envíala o anúlala primero.`
    default:
      return "No se puede anular todavía"
  }
}

/**
 * Dentro de `voidEncounter`, con la atención ya tomada: vuelve a decidir con el
 * plan tomado y responde conflicto si algo no se deshace o si lo entregado que
 * se anula no es lo que confirmó quien anula (alguien respondió o cobró
 * mientras tanto). Devuelve lo que hay que hacer al final de la cascada.
 */
export async function checkEncounterVoidBudgets(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
  opts: {
    actorUserId: string
    memberRole?: string
    seesCharges?: boolean
    confirmed?: ReadonlyArray<{ id: string; status: string }>
  },
): Promise<EncounterVoidBudget[]> {
  const preview = await encounterVoidBudgets(tx, orgId, patientId, encounterId, {
    ...opts,
    lock: true,
  })
  const stopped = preview.budgets.find((budget) => budget.effect === "frena")
  if (stopped) throw new ServiceError("VOID_BLOCKED", 409, blockedMessage(stopped))
  const key = (rows: ReadonlyArray<{ id: string; status: string }>) =>
    rows
      .map((row) => `${row.id}:${row.status}`)
      .sort()
      .join(",")
  if (key(preview.confirm) !== key(opts.confirmed ?? [])) {
    throw new ServiceError(
      "VOID_BUDGETS_CHANGED",
      409,
      preview.confirm.length > 0
        ? "Esta atención tiene un presupuesto entregado: revisa lo que se anula con ella y confirma otra vez"
        : "El presupuesto cambió mientras tanto: revisa lo que se anula y confirma otra vez",
    )
  }
  return preview.budgets
}

/** El final de la cascada: anula o deja sin lo de esta atención cada presupuesto que decidió `checkEncounterVoidBudgets`. */
export async function settleEncounterVoidBudgets(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  budgets: readonly EncounterVoidBudget[],
): Promise<void> {
  for (const budget of budgets) {
    if (budget.effect === "anula") {
      await cancelBudgetWithEncounter(tx, orgId, actorUserId, patientId, budget.id)
    } else if (budget.effect === "quita") {
      const here = await tx
        .selectDistinct({ planItemId: treatmentBudgetItem.planItemId })
        .from(treatmentBudgetItem)
        .innerJoin(
          treatmentPlanItem,
          and(
            eq(treatmentPlanItem.organizationId, treatmentBudgetItem.organizationId),
            eq(treatmentPlanItem.id, treatmentBudgetItem.planItemId),
          ),
        )
        .where(
          and(
            eq(treatmentBudgetItem.organizationId, orgId),
            eq(treatmentBudgetItem.budgetId, budget.id),
            eq(treatmentPlanItem.sourceEncounterId, encounterId),
          ),
        )
      if (here.length > 0) {
        // Solo lo indicado aquí: lo de otras atenciones (y de otros profesionales) sigue en el borrador.
        await removeBudgetItems(tx, orgId, actorUserId, patientId, budget.id, {
          itemIds: here.map((row) => row.planItemId),
        })
      }
    }
  }
}
