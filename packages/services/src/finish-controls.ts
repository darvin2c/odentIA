/**
 * Los controles que deja un tratamiento al terminar (decisión B5 del 10 nov): los de su
 * servicio (los de la clínica o los de la guía, `finishControlsSql`), en código común para
 * todos los productos. Antes era una regla fija de odentIA (el radiográfico del año de la
 * endodoncia). Uno por fecha (B4): si otro tratamiento terminado deja el mismo control el
 * mismo día, se suma a ese y el título nombra todos sus sitios («· piezas 46 y 36»), con una
 * sola cita y un solo recordatorio. Deshacer un tratamiento lo saca del control; sin ninguno,
 * el control se cancela.
 */
import { type FinishControl, finishControlTitle } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  clinicalFollowUp,
  clinicalFollowUpItem,
  serviceCatalog,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm"
import { zonedTimeToUtc } from "./availability.js"
import { findOrgLocale } from "./locale.js"
import { productHooks } from "./products.js"
import { finishControlsSql } from "./service-catalog.js"
import { dayKeyIn } from "./to-schedule.js"

/** La hora a la que se anota el día de un control (la de «¿Cuándo vuelve?»). */
const CONTROL_MINUTES = 9 * 60

function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** Los controles de su servicio, para un tratamiento. */
async function controlsOfItem(
  tx: Db,
  orgId: string,
  serviceId: string | null,
): Promise<FinishControl[]> {
  if (!serviceId) return []
  const [row] = await tx
    .select({ controls: finishControlsSql })
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.id, serviceId)))
    .limit(1)
  return Array.isArray(row?.controls) ? row.controls : []
}

/** El título con los sitios de sus tratamientos: «pieza 46», «piezas 46 y 36». */
async function titleWithPlaces(
  tx: Db,
  orgId: string,
  base: string,
  planItemIds: readonly string[],
): Promise<string> {
  if (planItemIds.length === 0) return base
  const { site } = await productHooks(tx, orgId)
  const rows = await tx
    .select({
      id: treatmentPlanItem.id,
      siteSystem: treatmentPlanItem.siteSystem,
      siteCode: treatmentPlanItem.siteCode,
      siteQualifiers: treatmentPlanItem.siteQualifiers,
      createdAt: treatmentPlanItem.createdAt,
    })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        inArray(treatmentPlanItem.id, [...planItemIds]),
      ),
    )
    .orderBy(asc(treatmentPlanItem.createdAt), asc(treatmentPlanItem.id))
  // En el orden en que se indicaron: el mismo título en el cierre y en el control.
  const words = rows
    .map((row) =>
      site.words(
        { siteSystem: row.siteSystem, siteCode: row.siteCode, siteQualifiers: [] },
        "short",
      ),
    )
    .filter((word): word is string => !!word)
  if (words.length === 0) return base
  // odentIA: «pieza 46» → una sola palabra para todas («piezas 46 y 36»).
  const teeth = words.map((word) => /^pieza (\S+)$/.exec(word)?.[1] ?? null)
  if (teeth.every((tooth) => tooth !== null))
    return finishControlTitle(base, teeth as string[], "pieza")
  return finishControlTitle(base, words, "")
}

/** El título sin sus sitios: lo que va antes de « · ». */
function baseOf(title: string): string {
  return title.split(" · ")[0] ?? title
}

/**
 * Al quedar realizado un tratamiento, los controles de su servicio. Se llama donde se llama a
 * `ProductHooks.treatmentDone`: una sola regla para registrar con una sesión, «Sí, terminar» al
 * firmar y «Completar» desde el Plan.
 */
export async function createFinishControls(
  tx: Db,
  scope: {
    orgId: string
    actorUserId: string
    patientId: string
    encounterId: string | null
    planItemId: string
  },
): Promise<void> {
  const { orgId, actorUserId, patientId, encounterId, planItemId } = scope
  const [item] = await tx
    .select({ id: treatmentPlanItem.id, serviceId: treatmentPlanItem.serviceId })
    .from(treatmentPlanItem)
    .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.id, planItemId)))
    .limit(1)
  if (!item) return
  const controls = await controlsOfItem(tx, orgId, item.serviceId)
  if (controls.length === 0) return
  const { timezone } = await findOrgLocale(tx, orgId)
  const today = dayKeyIn(new Date(), timezone)
  for (const control of controls) {
    const day = addDays(today, control.afterDays)
    const dueAt = zonedTimeToUtc(day, CONTROL_MINUTES, timezone)
    // Ya lo tiene por este tratamiento (se terminó dos veces): nada.
    const [mine] = await tx
      .select({ id: clinicalFollowUp.id })
      .from(clinicalFollowUpItem)
      .innerJoin(clinicalFollowUp, eq(clinicalFollowUp.id, clinicalFollowUpItem.followUpId))
      .where(
        and(
          eq(clinicalFollowUpItem.organizationId, orgId),
          eq(clinicalFollowUpItem.planItemId, planItemId),
          eq(clinicalFollowUp.finishAfterDays, control.afterDays),
          inArray(clinicalFollowUp.status, ["pendiente", "programado"]),
        ),
      )
      .limit(1)
    if (mine) continue
    // El mismo control el mismo día por otro tratamiento: uno solo, que nombra a los dos (B4).
    const sameDay = (
      await tx
        .select({
          id: clinicalFollowUp.id,
          title: clinicalFollowUp.title,
          dueAt: clinicalFollowUp.dueAt,
        })
        .from(clinicalFollowUp)
        .where(
          and(
            eq(clinicalFollowUp.organizationId, orgId),
            eq(clinicalFollowUp.patientId, patientId),
            eq(clinicalFollowUp.finishAfterDays, control.afterDays),
            eq(clinicalFollowUp.status, "pendiente"),
          ),
        )
    ).find((row) => baseOf(row.title) === control.title && dayKeyIn(row.dueAt, timezone) === day)
    if (sameDay) {
      await tx
        .insert(clinicalFollowUpItem)
        .values({ organizationId: orgId, patientId, followUpId: sameDay.id, planItemId })
        .onConflictDoNothing()
      await retitle(tx, orgId, sameDay.id, control.title)
      await tx.insert(auditEvent).values({
        organizationId: orgId,
        actorUserId,
        action: "follow_up.item_added",
        entity: "clinical_follow_up",
        entityId: sameDay.id,
        metadata: { patientId, planItemId, by: "tratamiento_terminado" },
      })
      continue
    }
    const [row] = await tx
      .insert(clinicalFollowUp)
      .values({
        organizationId: orgId,
        patientId,
        kind: "tratamiento",
        title: await titleWithPlaces(tx, orgId, control.title, [planItemId]),
        dueAt,
        planItemId,
        originEncounterId: encounterId,
        finishAfterDays: control.afterDays,
        createdBy: actorUserId,
      })
      .returning({ id: clinicalFollowUp.id })
    if (!row) continue
    await tx
      .insert(clinicalFollowUpItem)
      .values({ organizationId: orgId, patientId, followUpId: row.id, planItemId })
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "follow_up.created",
      entity: "clinical_follow_up",
      entityId: row.id,
      metadata: {
        patientId,
        planItemId,
        by: "tratamiento_terminado",
        afterDays: control.afterDays,
      },
    })
  }
}

/** Vuelve a escribir el título con los sitios de los tratamientos que le quedan. */
async function retitle(tx: Db, orgId: string, followUpId: string, base: string): Promise<string[]> {
  const items = await tx
    .select({ planItemId: clinicalFollowUpItem.planItemId })
    .from(clinicalFollowUpItem)
    .where(
      and(
        eq(clinicalFollowUpItem.organizationId, orgId),
        eq(clinicalFollowUpItem.followUpId, followUpId),
      ),
    )
    .orderBy(asc(clinicalFollowUpItem.createdAt), asc(clinicalFollowUpItem.planItemId))
  const ids = items.map((row) => row.planItemId)
  if (ids.length > 0)
    await tx
      .update(clinicalFollowUp)
      .set({ title: await titleWithPlaces(tx, orgId, base, ids), updatedAt: new Date() })
      .where(and(eq(clinicalFollowUp.organizationId, orgId), eq(clinicalFollowUp.id, followUpId)))
  return ids
}

/**
 * Deshacer un tratamiento terminado (anular su sesión o la atención): sin él no hay qué
 * controlar. Sale de sus controles abiertos; el que se queda sin ninguno se cancela.
 */
export async function undoFinishControls(
  tx: Db,
  scope: {
    orgId: string
    actorUserId: string
    patientId: string
    planItemId: string
    reason: string
    at: Date
  },
): Promise<void> {
  const { orgId, actorUserId, patientId, planItemId, reason, at } = scope
  const linked = await tx
    .select({
      id: clinicalFollowUp.id,
      title: clinicalFollowUp.title,
      planItemId: clinicalFollowUp.planItemId,
    })
    .from(clinicalFollowUpItem)
    .innerJoin(clinicalFollowUp, eq(clinicalFollowUp.id, clinicalFollowUpItem.followUpId))
    .where(
      and(
        eq(clinicalFollowUpItem.organizationId, orgId),
        eq(clinicalFollowUpItem.patientId, patientId),
        eq(clinicalFollowUpItem.planItemId, planItemId),
        isNotNull(clinicalFollowUp.finishAfterDays),
        eq(clinicalFollowUp.status, "pendiente"),
      ),
    )
  for (const control of linked) {
    await tx
      .delete(clinicalFollowUpItem)
      .where(
        and(
          eq(clinicalFollowUpItem.organizationId, orgId),
          eq(clinicalFollowUpItem.followUpId, control.id),
          eq(clinicalFollowUpItem.planItemId, planItemId),
        ),
      )
    const left = await retitle(tx, orgId, control.id, baseOf(control.title))
    if (left.length > 0) {
      if (control.planItemId === planItemId)
        await tx
          .update(clinicalFollowUp)
          .set({ planItemId: left[0]!, updatedAt: at })
          .where(
            and(eq(clinicalFollowUp.organizationId, orgId), eq(clinicalFollowUp.id, control.id)),
          )
      await tx.insert(auditEvent).values({
        organizationId: orgId,
        actorUserId,
        action: "follow_up.item_removed",
        entity: "clinical_follow_up",
        entityId: control.id,
        metadata: { patientId, planItemId, reason },
      })
      continue
    }
    await tx
      .update(clinicalFollowUp)
      .set({
        status: "cancelado",
        cancelledReason: reason.slice(0, 2000),
        cancelledAt: at,
        updatedAt: at,
      })
      .where(and(eq(clinicalFollowUp.organizationId, orgId), eq(clinicalFollowUp.id, control.id)))
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "follow_up.cancelled",
      entity: "clinical_follow_up",
      entityId: control.id,
      metadata: { patientId, planItemId, reason },
    })
  }
}

/** Un control que va a quedar al firmar: el de un tratamiento que termina con esta firma. */
export interface FinishingControl {
  /** Con qué se dice qué cambiar al firmar: «365|Control radiográfico de la endodoncia». */
  key: string
  title: string
  /** `YYYY-MM-DD`, en la zona de la clínica. */
  dueDay: string
  afterDays: number
}

/**
 * Los controles que dejarán los tratamientos que terminan al firmar (el cierre los muestra antes
 * de firmar, B5): por servicio, uno por fecha y título, con los sitios de todos.
 */
export async function finishingControlsOf(
  tx: Db,
  orgId: string,
  planItemIds: readonly string[],
): Promise<FinishingControl[]> {
  if (planItemIds.length === 0) return []
  const items = await tx
    .select({ id: treatmentPlanItem.id, serviceId: treatmentPlanItem.serviceId })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        inArray(treatmentPlanItem.id, [...planItemIds]),
      ),
    )
  const { timezone } = await findOrgLocale(tx, orgId)
  const today = dayKeyIn(new Date(), timezone)
  const byKey = new Map<string, { control: FinishControl; ids: string[] }>()
  for (const item of items)
    for (const control of await controlsOfItem(tx, orgId, item.serviceId)) {
      const key = `${control.afterDays}|${control.title}`
      const same = byKey.get(key)
      if (same) same.ids.push(item.id)
      else byKey.set(key, { control, ids: [item.id] })
    }
  const out: FinishingControl[] = []
  for (const [key, { control, ids }] of byKey)
    out.push({
      key,
      title: await titleWithPlaces(tx, orgId, control.title, ids),
      dueDay: addDays(today, control.afterDays),
      afterDays: control.afterDays,
    })
  return out.sort((a, b) => a.afterDays - b.afterDays)
}

/** Lo que quien firma cambió de un control que va a quedar: otro día o quitarlo. */
export type FinishingControlChange = { key: string; dueDay: string } | { key: string; remove: true }

/**
 * Aplica, ya firmada la atención, lo que se cambió en el cierre de los controles que dejó (solo
 * para esta persona): otro día o quitarlo. Se busca por su plazo y su título entre los que
 * nacieron hoy de sus tratamientos.
 */
export async function applyFinishingControlChanges(
  tx: Db,
  scope: { orgId: string; actorUserId: string; patientId: string; encounterId: string },
  changes: readonly FinishingControlChange[],
): Promise<void> {
  if (changes.length === 0) return
  const { orgId, actorUserId, patientId } = scope
  const { timezone } = await findOrgLocale(tx, orgId)
  const today = dayKeyIn(new Date(), timezone)
  const open = await tx
    .select({
      id: clinicalFollowUp.id,
      title: clinicalFollowUp.title,
      afterDays: clinicalFollowUp.finishAfterDays,
      dueAt: clinicalFollowUp.dueAt,
    })
    .from(clinicalFollowUp)
    .where(
      and(
        eq(clinicalFollowUp.organizationId, orgId),
        eq(clinicalFollowUp.patientId, patientId),
        isNotNull(clinicalFollowUp.finishAfterDays),
        eq(clinicalFollowUp.status, "pendiente"),
      ),
    )
  for (const change of changes) {
    const [days, ...rest] = change.key.split("|")
    const base = rest.join("|")
    const due = addDays(today, Number(days))
    const target = open.find(
      (row) =>
        row.afterDays === Number(days) &&
        baseOf(row.title) === base &&
        dayKeyIn(row.dueAt, timezone) === due,
    )
    if (!target) continue
    if ("remove" in change) {
      const at = new Date()
      // Si el control lleva también tratamientos de otra atención (uno por fecha), sale solo lo de
      // esta: se le quitan sus vínculos y el control sigue con los demás (revisión antes de entregar).
      const others = await tx.execute<{ plan_item_id: string }>(sql`
        select link.plan_item_id from clinical_follow_up_item link
        where link.organization_id = ${orgId} and link.follow_up_id = ${target.id}
          and not exists (select 1 from encounter_procedure today where today.organization_id = link.organization_id
            and today.plan_item_id = link.plan_item_id and today.encounter_id = ${scope.encounterId} and today.voided_at is null)`)
      if (others.length > 0) {
        const keep = others.map((row) => row.plan_item_id)
        await tx
          .delete(clinicalFollowUpItem)
          .where(
            and(
              eq(clinicalFollowUpItem.organizationId, orgId),
              eq(clinicalFollowUpItem.followUpId, target.id),
              notInArray(clinicalFollowUpItem.planItemId, keep),
            ),
          )
        await tx
          .update(clinicalFollowUp)
          .set({ planItemId: keep[0]!, updatedAt: at })
          .where(and(eq(clinicalFollowUp.organizationId, orgId), eq(clinicalFollowUp.id, target.id)))
        await retitle(tx, orgId, target.id, base)
        continue
      }
      await tx
        .update(clinicalFollowUp)
        .set({
          status: "cancelado",
          cancelledReason: "Quitado al firmar la atención",
          cancelledAt: at,
          updatedAt: at,
        })
        .where(and(eq(clinicalFollowUp.organizationId, orgId), eq(clinicalFollowUp.id, target.id)))
      await tx.insert(auditEvent).values({
        organizationId: orgId,
        actorUserId,
        action: "follow_up.cancelled",
        entity: "clinical_follow_up",
        entityId: target.id,
        metadata: { patientId, encounterId: scope.encounterId, by: "cierre" },
      })
      continue
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(change.dueDay) || change.dueDay <= today) continue
    const dueAt = zonedTimeToUtc(change.dueDay, CONTROL_MINUTES, timezone)
    await tx
      .update(clinicalFollowUp)
      .set({ dueAt, updatedAt: new Date() })
      .where(and(eq(clinicalFollowUp.organizationId, orgId), eq(clinicalFollowUp.id, target.id)))
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "follow_up.due_changed",
      entity: "clinical_follow_up",
      entityId: target.id,
      metadata: {
        patientId,
        from: target.dueAt.toISOString(),
        to: dueAt.toISOString(),
        by: "cierre",
      },
    })
  }
}
