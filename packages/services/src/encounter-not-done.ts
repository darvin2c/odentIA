/**
 * «No se hizo» en una atención firmada (mesa del cierre de la atención, 19 nov 2026). Luis firmó
 * resina en la 15 y en la 24 y solo hizo la 15: marca la 24 con un motivo escrito y, en una sola
 * operación, lo firmado queda tachado (no se borra) y lo que nació de él vuelve atrás:
 *
 * - el tratamiento vuelve al plan como estaba antes de hacerse (también el directo de ese día: la
 *   caries que lo pidió no queda sin nada indicado), y el odontograma deja de dibujarlo
 *   (`voidProcedureRow`, como al anularlo en el borrador);
 * - el diagnóstico que esa firma dio por resuelto con él vuelve a activo;
 * - los materiales de su servicio vuelven al almacén, hasta lo que salió (lo dictado a mano no:
 *   no se sabe qué parte era de este acto, y se avisa);
 * - el dinero lo mueve caja (regla del auditor): el cobro sin ningún pago se anula aquí mismo; uno
 *   con algo pagado no se toca y caja recibe una tarea para devolverlo o dejarlo a favor. Si al
 *   tratamiento le queda otra sesión vigente que cubre ese cobro, el cobro sigue.
 *
 * Queda además una adenda de la atención: es lo que acompaña a la hoja y al odontograma ya
 * firmados, que no se rehacen. Lo marca quien firmó o atendió, o quien es dueño o administra.
 */
import { formatMoney, quantityWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  clinicalFollowUp,
  clinicalFollowUpItem,
  encounterDiagnosis,
  encounterProcedure,
  patient,
  prescription,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm"
import {
  addEncounterAddendum,
  billingModeOfProcedure,
  type EncounterProcedureRow,
  lockEncounter,
  voidProcedureRow,
} from "./encounters.js"
import { isConsultationService } from "./closing-consultation.js"
import { invalidField, notFound, ServiceError } from "./errors.js"
import { findOrgLocale } from "./locale.js"
import { requirePatient } from "./patients.js"
import { voidCharge } from "./payments.js"
import { productHooks } from "./products.js"
import { correctEncounterMaterial, dictatedMaterials } from "./service-materials.js"
import { createTask } from "./tasks.js"

const conflict = (code: string, message: string) => new ServiceError(code, 409, message)
const forbidden = (message: string) => new ServiceError("FORBIDDEN", 403, message)

/** Quién puede: quien firmó o atendió, o quien es dueño o administra la clínica. */
const MANAGING_ROLES = new Set(["owner", "admin"])

export interface NotDoneCharge {
  id: string
  description: string
  /** Null para quien no ve la caja: se le dice qué pasa, no cuánto. */
  amountCents: number | null
  paidCents: number | null
  currency: string
  /**
   * `anula`: sin ningún pago, se anula al confirmar. `caja`: tiene algo pagado; no se toca y caja
   * recibe la tarea. `sigue`: el tratamiento sigue con otra sesión que este cobro cubre.
   */
  outcome: "anula" | "caja" | "sigue"
}

export interface NotDonePreview {
  procedure: { id: string; description: string; site: string | null }
  /**
   * El tratamiento del plan y cómo queda; null si fue algo hecho sin tratamiento. Una consulta no
   * vuelve al plan como algo por hacer: se quita («cancelado»).
   */
  planItem: { title: string; becomes: "pendiente" | "en_curso" | "cancelado" } | null
  /** Los diagnósticos que esa firma resolvió con este tratamiento y vuelven a activos. */
  diagnoses: string[]
  /** Lo que vuelve al almacén. */
  materials: Array<{ productId: string; name: string; quantity: number; quantityText: string }>
  /** Hubo material dicho a mano en la atención: no se devuelve solo. */
  dictatedMaterials: boolean
  charges: NotDoneCharge[]
  /** Controles que dejó y ya tienen cita: siguen en la agenda; se mueven a mano. */
  bookedControls: Array<{ title: string; dueAt: Date }>
  /** La atención tiene una receta vigente: no se anula sola. */
  prescription: boolean
}

export interface NotDoneResult extends NotDonePreview {
  procedureRow: EncounterProcedureRow
  /** La tarea que recibió caja, si había algo pagado. */
  cashierTaskId: string | null
}

function cleanReason(reason: string | null | undefined): string {
  const text = reason?.trim() ?? ""
  if (text.length < 1 || text.length > 2000) throw invalidField("reason", "Escribe por qué no se hizo: hasta 2000 caracteres")
  return text
}

/** La atención firmada, el procedimiento vigente y que quien lo pide puede hacerlo. */
async function loadScope(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  procedureId: string,
  opts: { memberRole?: string },
) {
  await requirePatient(tx, orgId, patientId)
  // Como al firmar: la cuenta del paciente primero, para que un pago en medio no cambie lo decidido.
  await tx
    .select({ id: patient.id })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .for("update")
  const row = await lockEncounter(tx, orgId, patientId, encounterId)
  if (row.status !== "finalizada")
    throw conflict("NOT_FINALIZED", "«No se hizo» es para una atención firmada; en el borrador, anúlalo en su fila")
  const own = row.finalizedBy === actorUserId || row.professionalUserId === actorUserId
  if (!own && !MANAGING_ROLES.has(opts.memberRole ?? ""))
    throw forbidden("Lo marca quien firmó la atención, o el dueño o quien administra la clínica")
  const [proc] = await tx
    .select()
    .from(encounterProcedure)
    .where(
      and(
        eq(encounterProcedure.organizationId, orgId),
        eq(encounterProcedure.encounterId, encounterId),
        eq(encounterProcedure.id, procedureId),
      ),
    )
    .for("update")
    .limit(1)
  if (!proc) throw notFound("Procedimiento")
  if (proc.voidedAt) throw conflict("ALREADY_VOIDED", "Ya está marcado como no hecho")
  return { row, proc }
}

/** Lo que esa firma dio por resuelto con este tratamiento (`resolveDiagnosesOnSign` lo deja en la auditoría). */
async function resolvedBySigning(tx: Db, orgId: string, encounterId: string, planItemId: string | null) {
  if (!planItemId) return []
  return tx.execute<{ id: string; title: string }>(sql`
    select d.id, coalesce(c.title, d.diagnosis_code) as title
    from audit_event a
    join encounter_diagnosis d on d.organization_id = a.organization_id and d.id::text = a.entity_id
    left join diagnosis_code c on c.system_key = d.diagnosis_system and c.code = d.diagnosis_code
    where a.organization_id = ${orgId} and a.action = 'encounter.diagnosis_status'
      and a.metadata->>'encounterId' = ${encounterId} and a.metadata->>'planItemId' = ${planItemId}
      and a.metadata->>'to' = 'resuelto' and d.status = 'resuelto' and d.voided_at is null`)
}

/** Lo de su servicio por su cantidad, hasta lo que salió de cada producto con la atención. */
async function materialsOf(
  tx: Db,
  orgId: string,
  encounterId: string,
  proc: typeof encounterProcedure.$inferSelect,
): Promise<{ items: NotDonePreview["materials"]; dictated: boolean }> {
  const dictated = await dictatedMaterials(tx, orgId, encounterId)
  if (!proc.serviceId) return { items: [], dictated: dictated.size > 0 }
  const rows = await tx.execute<{ product_id: string; name: string; unit: string; quantity: number; used: number }>(sql`
    select sm.product_id, p.name, p.unit, (sm.quantity * ${proc.quantity ?? 1})::int as quantity,
      coalesce((select (-sum(m.quantity_delta))::int from stock_movement m
        where m.organization_id = sm.organization_id and m.encounter_id = ${encounterId} and m.product_id = sm.product_id), 0) as used
    from service_material sm
    join product p on p.organization_id = sm.organization_id and p.id = sm.product_id
    where sm.organization_id = ${orgId} and sm.service_id = ${proc.serviceId}
    order by p.name`)
  const { locale } = await findOrgLocale(tx, orgId)
  const items = rows.flatMap((row) => {
    // Lo dictado reemplaza lo del servicio: no se sabe qué parte era de este acto.
    if (dictated.has(row.product_id)) return []
    const quantity = Math.min(Number(row.quantity), Number(row.used))
    if (quantity <= 0) return []
    return [{ productId: row.product_id, name: row.name, quantity, quantityText: quantityWords(quantity, row.unit, locale) }]
  })
  return { items, dictated: dictated.size > 0 }
}

/** Sus cobros y qué pasa con cada uno. */
async function chargesOf(
  tx: Db,
  orgId: string,
  patientId: string,
  proc: typeof encounterProcedure.$inferSelect,
): Promise<NotDoneCharge[]> {
  const rows = (
    await tx.execute<{ id: string; description: string; amount_cents: number; currency: string; paid_cents: number }>(sql`
      select c.id, c.description, c.amount_cents, c.currency,
        coalesce((select sum(a.amount_cents) from patient_payment_application a
          where a.organization_id = c.organization_id and a.charge_id = c.id and a.voided_at is null), 0)::int as paid_cents
      from patient_charge c
      where c.organization_id = ${orgId} and c.patient_id = ${patientId}
        and c.encounter_procedure_id = ${proc.id} and c.voided_at is null
      order by c.created_at, c.id`)
  ).map((row) => ({
    id: row.id,
    description: row.description,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    paidCents: Number(row.paid_cents),
  }))
  if (rows.length === 0) return []
  // Por sesión, el cobro es solo de esta visita. Por tratamiento (entero en la primera), lo cubre
  // todo: si al tratamiento le queda otra sesión ya firmada, el cobro sigue (revisión del 19 nov:
  // deducirlo de si las otras tienen su cobro tomaba por «sigue» una sesión aún en borrador).
  let coversOthers = false
  if (proc.planItemId && (await billingModeOfProcedure(tx, orgId, patientId, proc)) === "treatment") {
    const [others] = await tx.execute<{ sessions: number }>(sql`
      select count(*)::int as sessions
      from encounter_procedure ep
      join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id
      where ep.organization_id = ${orgId} and ep.plan_item_id = ${proc.planItemId}
        and ep.id <> ${proc.id} and ep.voided_at is null and e.status = 'finalizada'`)
    coversOthers = (others?.sessions ?? 0) > 0
  }
  return rows.map((row) => ({
    ...row,
    outcome: coversOthers ? "sigue" : row.paidCents > 0 ? "caja" : "anula",
  }))
}

async function previewOf(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
  proc: typeof encounterProcedure.$inferSelect,
): Promise<NotDonePreview> {
  const hooks = await productHooks(tx, orgId)
  const [item] = proc.planItemId
    ? await tx
        .select({ id: treatmentPlanItem.id, title: treatmentPlanItem.title })
        .from(treatmentPlanItem)
        .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.id, proc.planItemId)))
        .limit(1)
    : []
  const [others] = proc.planItemId
    ? await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(encounterProcedure)
        .where(
          and(
            eq(encounterProcedure.organizationId, orgId),
            eq(encounterProcedure.planItemId, proc.planItemId),
            ne(encounterProcedure.id, proc.id),
            isNull(encounterProcedure.voidedAt),
          ),
        )
    : []
  const materials = await materialsOf(tx, orgId, encounterId, proc)
  const booked = proc.planItemId
    ? await tx
        .select({ title: clinicalFollowUp.title, dueAt: clinicalFollowUp.dueAt })
        .from(clinicalFollowUpItem)
        .innerJoin(clinicalFollowUp, eq(clinicalFollowUp.id, clinicalFollowUpItem.followUpId))
        .where(
          and(
            eq(clinicalFollowUpItem.organizationId, orgId),
            eq(clinicalFollowUpItem.patientId, patientId),
            eq(clinicalFollowUpItem.planItemId, proc.planItemId),
            eq(clinicalFollowUp.status, "programado"),
          ),
        )
    : []
  const [recipe] = await tx
    .select({ id: prescription.id })
    .from(prescription)
    .where(
      and(
        eq(prescription.organizationId, orgId),
        eq(prescription.encounterId, encounterId),
        ne(prescription.status, "anulada"),
      ),
    )
    .limit(1)
  const consultation = await isConsultationService(tx, orgId, proc.serviceId)
  return {
    procedure: { id: proc.id, description: proc.description, site: hooks.site.words(proc, "short") },
    planItem: item
      ? { title: item.title, becomes: (others?.n ?? 0) > 0 ? "en_curso" : consultation ? "cancelado" : "pendiente" }
      : null,
    diagnoses: (await resolvedBySigning(tx, orgId, encounterId, proc.planItemId)).map((row) => row.title),
    materials: materials.items,
    dictatedMaterials: materials.dictated,
    charges: await chargesOf(tx, orgId, patientId, proc),
    bookedControls: booked,
    prescription: Boolean(recipe),
  }
}

/** Sin `finance.read` se dice qué pasa con el cobro, no cuánto («odontología no recibe caja»). */
function forReader<T extends NotDonePreview>(preview: T, seesCharges: boolean): T {
  if (seesCharges) return preview
  return { ...preview, charges: preview.charges.map((charge) => ({ ...charge, amountCents: null, paidCents: null })) }
}

/** Lo que pasará al marcar «No se hizo», para decirlo antes de confirmar. */
export async function getNotDonePreview(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  procedureId: string,
  opts: { memberRole?: string; seesCharges?: boolean } = {},
): Promise<NotDonePreview> {
  const { proc } = await loadScope(tx, orgId, actorUserId, patientId, encounterId, procedureId, opts)
  return forReader(await previewOf(tx, orgId, patientId, encounterId, proc), opts.seesCharges ?? false)
}

export async function markProcedureNotDone(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  procedureId: string,
  input: { reason: string },
  opts: { memberRole?: string; seesCharges?: boolean } = {},
): Promise<NotDoneResult> {
  const reason = cleanReason(input.reason)
  const { proc } = await loadScope(tx, orgId, actorUserId, patientId, encounterId, procedureId, opts)
  const preview = await previewOf(tx, orgId, patientId, encounterId, proc)
  const at = new Date()
  const why = `No se hizo: ${reason}`.slice(0, 2000)
  const label = [proc.description, preview.procedure.site].filter(Boolean).join(" · ")

  // Lo resuelto por esa firma, antes de que el tratamiento deje de estar realizado.
  const resolved = await resolvedBySigning(tx, orgId, encounterId, proc.planItemId)
  const backToPlan = preview.planItem?.becomes !== "cancelado"
  const procedureRow = await voidProcedureRow(tx, orgId, actorUserId, patientId, encounterId, proc, why, at, null, backToPlan)
  if (resolved.length > 0) {
    const ids = resolved.map((row) => row.id)
    await tx
      .update(encounterDiagnosis)
      .set({ status: "activo", resolvedAt: null, updatedAt: at })
      .where(and(eq(encounterDiagnosis.organizationId, orgId), inArray(encounterDiagnosis.id, ids)))
    for (const id of ids)
      await tx.insert(auditEvent).values({
        organizationId: orgId,
        actorUserId,
        action: "encounter.diagnosis_status",
        entity: "encounter_diagnosis",
        entityId: id,
        metadata: { patientId, from: "resuelto", to: "activo", encounterId, planItemId: proc.planItemId, notDone: true },
      })
  }

  // Los materiales de su servicio, de vuelta al almacén (con la corrección de siempre).
  for (const material of preview.materials) {
    const [used] = await tx.execute<{ used: number }>(sql`
      select coalesce((-sum(quantity_delta))::int, 0) as used from stock_movement
      where organization_id = ${orgId} and encounter_id = ${encounterId} and product_id = ${material.productId}`)
    const now = Number(used?.used ?? 0)
    await correctEncounterMaterial(
      tx,
      orgId,
      actorUserId,
      patientId,
      encounterId,
      { productId: material.productId, quantity: Math.max(0, now - material.quantity), idempotencyKey: `no-se-hizo:${proc.id}` },
      () => true,
    )
  }

  // El dinero: lo que nadie pagó se anula; lo pagado es de caja.
  const { locale } = await findOrgLocale(tx, orgId)
  let cashierTaskId: string | null = null
  const paid = preview.charges.filter((charge) => charge.outcome === "caja")
  for (const charge of preview.charges.filter((row) => row.outcome === "anula"))
    await voidCharge(tx, orgId, actorUserId, patientId, charge.id, { reason: why })
  if (paid.length > 0) {
    const money = paid.map((charge) => formatMoney(charge.paidCents ?? 0, charge.currency, locale)).join(" y ")
    // Lo pagado queda para el tratamiento solo si se cobra por tratamiento y sigue en el plan; por
    // sesión, esta visita no se hizo y lo pagado es de ella (revisión del 19 nov).
    const stays =
      backToPlan &&
      preview.planItem !== null &&
      (await billingModeOfProcedure(tx, orgId, patientId, proc)) === "treatment"
    const task = await createTask(tx, orgId, {
      title: `No se hizo y ya estaba pagado: ${label}`.slice(0, 200),
      patientId,
      area: "caja",
      createdBy: "sistema",
      actorUserId,
      reason: `Pagó ${money}. Motivo: «${reason}». ${
        stays
          ? "Sigue en su plan: lo pagado queda para cuando se haga; devuélvelo solo si lo pide."
          : "Devuélvelo o déjalo a favor desde su cuenta."
      }`,
      idempotencyKey: `no-se-hizo:${proc.id}`,
    })
    cashierTaskId = task.id
  }

  // Lo que acompaña a lo ya firmado (la hoja y el odontograma no se rehacen).
  await addEncounterAddendum(tx, orgId, actorUserId, patientId, encounterId, {
    text: `No se hizo: ${label}. Motivo: ${reason}`.slice(0, 4000),
  })
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "encounter.procedure_not_done",
    entity: "encounter_procedure",
    entityId: proc.id,
    metadata: {
      patientId,
      encounterId,
      planItemId: proc.planItemId,
      reason,
      voidedCharges: preview.charges.filter((row) => row.outcome === "anula").map((row) => row.id),
      paidCharges: paid.map((row) => row.id),
    },
  })
  return { ...forReader(preview, opts.seesCharges ?? false), procedureRow, cashierTaskId }
}
