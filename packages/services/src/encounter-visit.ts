/**
 * Lo que se puede hacer hoy (QA de la atención del 8 nov, propuesta 4.1; la atención agrupada,
 * 17 nov): a qué viene la persona, con o sin cita, calculado aquí y no en la pantalla. Lo que trae
 * su cita, la cita misma (su hora y su profesional), los tratamientos aceptados que tiene por
 * hacer (con la sesión que le toca hoy) y los controles por cumplir. La atención lo dice en la
 * fila de cada tratamiento del Plan.
 *
 * Elegir es preparar, no hacer: «Hacer hoy» une el tratamiento a la atención
 * (como la cita que lo trae) y propone el motivo y el diagnóstico que sigue; la
 * sesión cuenta recién al registrar su procedimiento. «Viene a su control»
 * deja anotado cuál es: el cierre lo trae marcado y se cumple al firmar.
 */
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import {
  clinicalFollowUp,
  encounter,
  encounterDiagnosis,
  encounterPlanItem,
  encounterSite,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm"
import { getDiagnosisSuggestions } from "./diagnosis-codes.js"
import { recordEncounterDiagnosis } from "./encounter-diagnoses.js"
import {
  assertLinkablePlans,
  assertOpenDraft,
  bookedReasonOf,
  dueControlsOf,
  type EncounterRow,
  lockEncounter,
} from "./encounters.js"
import { notFound, ServiceError } from "./errors.js"

const conflict = (code: string, message: string): ServiceError =>
  new ServiceError(code, 409, message)

import { type TreatmentConsentState, treatmentConsentStates } from "./consent-state.js"
import { findOrgLocale } from "./locale.js"
import { requirePatient } from "./patients.js"
import { withSite } from "./product-hooks.js"
import { productHooks } from "./products.js"
import { nextSessionGapOf } from "./session-gap.js"
import { goesBeforeSql, planItemSql, TO_SCHEDULE_STATUSES } from "./to-schedule.js"

/** Un tratamiento aceptado por hacer, con la sesión que le toca hoy. */
export interface VisitTreatment {
  planItemId: string
  title: string
  /** El sitio suelto (odentIA: la pieza); null sin sitio o en latidIA. */
  toothNumber: number | null
  /** «sesión 2 de 2»: `n` es la de hoy (las hechas en otras atenciones + 1); `m`, las previstas. */
  n: number
  m: number
  /** Ya empezó (alguna sesión hecha en otra atención, o en curso). */
  started: boolean
  /** Unido a esta atención (por su cita o por «Hacer hoy»). */
  linked: boolean
  /** Ya tiene un procedimiento vigente en esta atención: la sesión de hoy está registrada. */
  registered: boolean
  /** Lo trae la cita de esta atención: «Hoy no» no lo saca (el cierre avisa si no se hizo). */
  broughtByAppointment: boolean
  /**
   * Va después de otro tratamiento de la misma pieza (`waitingFor`, la regla de «Qué sigue»): la
   * corona tras la endodoncia. `today`: lo de antes se hace en esta atención. Es un aviso: «Hacerla
   * hoy» sigue, como segunda opción (entrega 8).
   */
  after: { title: string; today: boolean } | null
  /** Su consentimiento, si su servicio lo pide (`treatmentConsentStates`); null si no lo pide o ya está firmado. */
  consent?: TreatmentConsentState | null
  /** Los consentimientos que faltan preparar, por su título: la pantalla dice cuál. */
  consentMissing?: string[]
  /**
   * Su servicio pide esperar entre sesiones y aún no se cumple (la regla de la reserva,
   * `nextSessionGapOf`): `days` los que pide, `sinceDays` los que pasaron desde la última
   * sesión (0 = hoy) y `from` desde qué día convendría. Es un aviso, no un freno: «Continuar hoy»
   * sigue (QA del 10 nov, B6). Null si no espera nada o ya se cumplió.
   */
  wait: { days: number; sinceDays: number; from: string } | null
}

/** Un control con su ventana abierta: esta visita puede cumplirlo. */
export interface VisitControl {
  id: string
  title: string
  dueAt: Date
  /** Su día ya pasó: «vencido el 4 may». */
  overdue: boolean
  /** Quien lo indicó, si no fue quien atiende hoy: «de la Dra. Ana». */
  byName: string | null
  /** Se eligió al empezar («Viene a su control»): se cumple al firmar. */
  chosen: boolean
  /**
   * Reservado en la cita de esta atención: viene a él y se cumple al firmar, sin elegirlo. Se sigue
   * viendo después de usar la cita como motivo (QA del 9 nov, repaso 3).
   */
  byAppointment?: boolean
}

export interface EncounterVisit {
  /**
   * Todo lo aceptado que se puede hacer hoy, sin tope y también lo indicado en esta misma
   * atención: el Plan de la atención es el único lugar de cada tratamiento, y cada fila dice con
   * esto si se hace hoy, si ya se registró, su sesión, su espera y su consentimiento.
   */
  treatments: VisitTreatment[]
  controls: VisitControl[]
  /**
   * Sin cita hoy: su próxima cita ya reservada, para no reservarle otra ni hacer hoy lo que esa
   * viene a hacer sin saberlo (QA del 9 nov). Nula con cita o sin ninguna por venir.
   */
  booked: { startsAt: Date; serviceName: string | null } | null
  /**
   * La cita de esta atención: su hora y con quién. «Su cita» la dice al ofrecer su motivo, porque
   * puede ser la de otra profesional (la sesión 2 adelantada en la agenda de la Dra. Vela).
   */
  appointment: { startsAt: Date; professionalName: string | null } | null
}

/** Lo que se le ofrece «Hacer hoy»: aceptado y por hacer, y donde hace falta, con su presupuesto aceptado. */
function linkableSql(orgId: string, patientId: string, budgetRequired: boolean) {
  return sql`i.organization_id = ${orgId} and i.patient_id = ${patientId}
    and i.decision_status = 'aceptado' and i.status in (${sql.join(
      TO_SCHEDULE_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    )})
    ${
      budgetRequired
        ? sql`and (exists (select 1 from treatment_budget b where b.id = i.budget_id and b.organization_id = i.organization_id
            and b.status in ('aceptado','parcial'))
            or (i.budget_id is null and exists (select 1 from encounter_procedure done where done.organization_id = i.organization_id
              and done.plan_item_id = i.id and done.voided_at is null)))`
        : sql``
    }`
}

/** `YYYY-MM-DD` en la zona de la clínica. */
function dayIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(date)
}

/** Días de `from` a `to` (`YYYY-MM-DD`). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/** Lo que se puede hacer hoy en un borrador. Una atención firmada o anulada no lo tiene. */
export async function encounterVisitOf(
  tx: Db,
  orgId: string,
  row: EncounterRow,
): Promise<EncounterVisit | null> {
  if (row.status !== "borrador") return null
  const { site, budgetRequired, planPhases } = await productHooks(tx, orgId)
  const goesBefore = goesBeforeSql(planItemSql("i"), planItemSql("before_item"), planPhases)
  const rows = await tx.execute<{
    id: string
    title: string
    site_system: string | null
    site_code: string | null
    status: string
    m: number
    done_before: number
    linked: boolean
    registered: boolean
    by_appointment: boolean
    after_title: string | null
    after_today: boolean | null
  }>(sql`
    select i.id, i.title, i.site_system, i.site_code, i.status, i.planned_sessions as m,
      (select count(distinct done_procedure.encounter_id)::int from encounter_procedure done_procedure
        join encounter done_encounter on done_encounter.organization_id = done_procedure.organization_id
          and done_encounter.id = done_procedure.encounter_id
        where done_procedure.organization_id = i.organization_id and done_procedure.plan_item_id = i.id
          and done_procedure.voided_at is null and done_encounter.status <> 'anulada'
          and done_encounter.id <> ${row.id}) as done_before,
      exists (select 1 from encounter_plan_item linked where linked.organization_id = i.organization_id
        and linked.plan_item_id = i.id and linked.encounter_id = ${row.id}) as linked,
      exists (select 1 from encounter_procedure today where today.organization_id = i.organization_id
        and today.plan_item_id = i.id and today.encounter_id = ${row.id} and today.voided_at is null) as registered,
      ${
        row.appointmentId
          ? sql`exists (select 1 from appointment_plan_item brought where brought.organization_id = i.organization_id
        and brought.plan_item_id = i.id and brought.appointment_id = ${row.appointmentId})`
          : sql`false`
      } as by_appointment,
      (select before_item.title from treatment_plan_item before_item where ${goesBefore}
        order by (before_item.status = 'en_curso') desc, before_item.sort_order, before_item.created_at limit 1) as after_title,
      (select exists (select 1 from encounter_plan_item today_before where today_before.organization_id = before_item.organization_id
        and today_before.plan_item_id = before_item.id and today_before.encounter_id = ${row.id})
        from treatment_plan_item before_item where ${goesBefore}
        order by (before_item.status = 'en_curso') desc, before_item.sort_order, before_item.created_at limit 1) as after_today
    from treatment_plan_item i
    where ${linkableSql(orgId, row.patientId, budgetRequired)}
    order by linked desc, (i.status = 'en_curso') desc, i.sort_order, i.created_at, i.id`)
  // Lo que va después de otro, al final (salvo que ya se eligió para hoy): primero lo que toca.
  const place = (item: (typeof rows)[number]) => (item.linked ? 0 : item.after_title ? 2 : 1)
  const ordered = [...rows].sort((x, y) => place(x) - place(y))
  const { timezone } = await findOrgLocale(tx, orgId)
  // La espera entre sesiones de lo que ya empezó y aún no se registra hoy (B6): la misma regla
  // con que la reserva busca la próxima sesión.
  const shown = ordered
  const gaps = await nextSessionGapOf(
    tx,
    orgId,
    shown.filter((item) => Number(item.done_before) > 0 && !item.registered).map((item) => item.id),
  )
  const today = dayIn(new Date(), timezone)
  const consents = await treatmentConsentStates(tx, orgId, shown.map((item) => item.id))
  const treatments = shown.map((item) => {
    const done = Number(item.done_before)
    const gap = gaps.get(item.id)
    return {
      planItemId: item.id,
      title: item.title,
      toothNumber: item.site_system === site.system ? site.value(item.site_code) : null,
      n: done + 1,
      m: Number(item.m),
      started: done > 0 || item.status === "en_curso",
      linked: Boolean(item.linked),
      registered: Boolean(item.registered),
      broughtByAppointment: Boolean(item.by_appointment),
      after: item.after_title
        ? { title: item.after_title, today: Boolean(item.after_today) }
        : null,
      wait: gap
        ? {
            days: gap.days,
            sinceDays: Math.max(0, gap.days - daysBetween(today, gap.from)),
            from: gap.from,
          }
        : null,
      // Su consentimiento, aunque se preparara en otra atención: se firma antes de empezar.
      consent: consents.get(item.id)?.state ?? null,
      consentMissing: consents.get(item.id)?.missing ?? [],
    }
  })
  const due = await dueControlsOf(tx, orgId, row.professionalUserId, row, timezone)
  // El control reservado en la cita de hoy no está «por cumplir» (ya tiene cita): es a lo que viene.
  const booked = row.appointmentId
    ? await tx
        .select({
          id: clinicalFollowUp.id,
          title: clinicalFollowUp.title,
          dueAt: clinicalFollowUp.dueAt,
          originProfessionalUserId: encounter.professionalUserId,
        })
        .from(clinicalFollowUp)
        .leftJoin(
          encounter,
          and(eq(encounter.id, clinicalFollowUp.originEncounterId), eq(encounter.organizationId, clinicalFollowUp.organizationId)),
        )
        .where(
          and(
            eq(clinicalFollowUp.organizationId, orgId),
            eq(clinicalFollowUp.patientId, row.patientId),
            eq(clinicalFollowUp.status, "programado"),
            eq(clinicalFollowUp.appointmentId, row.appointmentId),
          ),
        )
    : []
  const others = [
    ...new Set(
      [...due, ...booked].flatMap((control) =>
        control.originProfessionalUserId &&
        control.originProfessionalUserId !== row.professionalUserId
          ? [control.originProfessionalUserId]
          : [],
      ),
    ),
  ]
  const names = others.length
    ? new Map(
        (
          await tx
            .select({ id: user.id, name: user.name })
            .from(user)
            .where(inArray(user.id, others))
        ).map((person) => [person.id, person.name] as const),
      )
    : new Map<string, string>()
  const now = Date.now()
  const [mine] = row.appointmentId
    ? await tx.execute<{ startsAt: Date; professionalName: string | null }>(sql`
      select a.starts_at as "startsAt", u.name as "professionalName" from appointment a
      left join "user" u on u.id = a.professional_user_id
      where a.organization_id = ${orgId} and a.id = ${row.appointmentId} limit 1`)
    : []
  const [next] = row.appointmentId
    ? []
    : await tx.execute<{ startsAt: Date; serviceName: string | null }>(sql`
      select starts_at as "startsAt", service_name as "serviceName" from appointment
      where organization_id = ${orgId} and patient_id = ${row.patientId} and status in ('programada', 'confirmada')
        and starts_at > now() and not is_test
      order by starts_at limit 1`)
  return {
    booked: next ? { startsAt: new Date(next.startsAt), serviceName: next.serviceName } : null,
    appointment: mine
      ? { startsAt: new Date(mine.startsAt), professionalName: mine.professionalName }
      : null,
    treatments,
    controls: [
      ...booked.map((control) => ({
        id: control.id,
        title: control.title,
        dueAt: control.dueAt,
        overdue: control.dueAt.getTime() < now,
        byName: control.originProfessionalUserId
          ? (names.get(control.originProfessionalUserId) ?? null)
          : null,
        chosen: true,
        byAppointment: true,
      })),
      ...due.map((control) => ({
      id: control.id,
      title: control.title,
      dueAt: control.dueAt,
      overdue: control.dueAt.getTime() < now,
      byName: control.originProfessionalUserId
        ? (names.get(control.originProfessionalUserId) ?? null)
        : null,
      chosen: control.chosen,
    })),
    ],
  }
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  action: string,
  encounterId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity: "encounter",
    entityId: encounterId,
    metadata: data,
  })
}

/** Lo que trae el borrador abierto por quien atiende. */
async function openDraft(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
): Promise<EncounterRow> {
  await requirePatient(tx, orgId, patientId)
  const row = await lockEncounter(tx, orgId, patientId, encounterId)
  assertOpenDraft(row, actorUserId)
  return row
}

/** El sitio de una propuesta o un diagnóstico como lo pide el alta: la pieza, o si no el área (sin caras). */
function siteInput(site: Record<string, unknown>): {
  toothNumber: number | null
  quadrant: number | null
  arch: string | null
} {
  const tooth = typeof site["toothNumber"] === "number" ? site["toothNumber"] : null
  const quadrant = tooth == null && typeof site["quadrant"] === "number" ? site["quadrant"] : null
  const arch =
    tooth == null && quadrant == null && typeof site["arch"] === "string" ? site["arch"] : null
  return { toothNumber: tooth, quadrant, arch }
}

/** «Continúa: Endodoncia anterior vital de la 46», como lo dice la cita que lo trae. */
function continuesWords(title: string, tooth: number | null): string {
  return `Continúa: ${startWords(title, tooth)}`
}

/**
 * Lo que aún no empezó se nombra tal cual: «Resina fotocurable de la 16», no «Continúa: …», que
 * diría que hubo una sesión antes (QA en pantalla del 17 nov, D9).
 */
function startWords(title: string, tooth: number | null): string {
  return tooth != null ? `${title.trim()} de la ${tooth}` : title.trim()
}

/**
 * El diagnóstico que sigue con el tratamiento, nunca uno ya resuelto (QA del 10 nov, A2: la
 * corona después de la endodoncia traía la pulpitis que la endodoncia había resuelto):
 * 1. el de su sesión anterior, en su mismo sitio y aún activo;
 * 2. el suyo, con el tipo de la última vez (la misma propuesta que «Usar»), si sigue activo;
 * 3. el de la atención donde se indicó, en su mismo sitio y aún activo.
 * Sin ninguno, nada: el clínico lo elige.
 */
async function continuingDiagnosis(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  item: typeof treatmentPlanItem.$inferSelect,
): Promise<boolean> {
  const { site } = await productHooks(tx, orgId)
  const sameSite = item.siteCode
    ? and(
        eq(encounterDiagnosis.siteSystem, item.siteSystem ?? ""),
        eq(encounterDiagnosis.siteCode, item.siteCode),
      )
    : isNull(encounterDiagnosis.siteCode)
  /** El último diagnóstico activo, con tipo, de esa atención en el sitio del tratamiento. */
  const activeIn = async (fromEncounterId: string) => {
    const rows = await tx
      .select()
      .from(encounterDiagnosis)
      .innerJoin(
        encounter,
        and(
          eq(encounter.id, encounterDiagnosis.encounterId),
          eq(encounter.organizationId, encounterDiagnosis.organizationId),
        ),
      )
      .where(
        and(
          eq(encounterDiagnosis.organizationId, orgId),
          eq(encounterDiagnosis.encounterId, fromEncounterId),
          isNull(encounterDiagnosis.voidedAt),
          isNotNull(encounterDiagnosis.diagnosisType),
          eq(encounterDiagnosis.status, "activo"),
          sql`${encounter.status} <> 'anulada'`,
          sameSite,
        ),
      )
      .orderBy(desc(encounterDiagnosis.createdAt), desc(encounterDiagnosis.id))
    // El del propio tratamiento, si está; si no, el último de su sitio.
    const own = item.diagnosisCode ? rows.find((row) => row.encounter_diagnosis.diagnosisCode === item.diagnosisCode) : undefined
    return (own ?? rows[0])?.encounter_diagnosis ?? null
  }
  const record = async (diagnosis: typeof encounterDiagnosis.$inferSelect) => {
    if (!diagnosis.diagnosisType) return false
    await recordEncounterDiagnosis(tx, orgId, actorUserId, patientId, encounterId, {
      diagnosisCode: diagnosis.diagnosisCode,
      diagnosisSystem: diagnosis.diagnosisSystem,
      diagnosisType: diagnosis.diagnosisType,
      ...siteInput(withSite(site, diagnosis)),
    })
    return true
  }
  // 1. La sesión anterior de este mismo tratamiento (otra atención, no anulada).
  const previous = await tx.execute<{ encounter_id: string }>(sql`
    select done.encounter_id from encounter_procedure done
    join encounter e on e.organization_id = done.organization_id and e.id = done.encounter_id
    where done.organization_id = ${orgId} and done.plan_item_id = ${item.id}
      and done.voided_at is null and done.encounter_id <> ${encounterId} and e.status <> 'anulada'
    order by done.created_at desc, done.id desc
    limit 1`)
  const previousEncounterId = previous[0]?.encounter_id
  if (previousEncounterId) {
    const found = await activeIn(previousEncounterId)
    if (found) return record(found)
  }
  if (item.diagnosisCode) {
    // Ya resuelto en ese sitio (y sin ninguno activo): no se trae (A2).
    const [stillActive] = await tx
      .select({ id: encounterDiagnosis.id })
      .from(encounterDiagnosis)
      .where(
        and(
          eq(encounterDiagnosis.organizationId, orgId),
          eq(encounterDiagnosis.patientId, patientId),
          eq(encounterDiagnosis.diagnosisCode, item.diagnosisCode),
          isNull(encounterDiagnosis.voidedAt),
          eq(encounterDiagnosis.status, "activo"),
          sameSite,
        ),
      )
      .limit(1)
    const [resolved] = stillActive
      ? []
      : await tx
          .select({ id: encounterDiagnosis.id })
          .from(encounterDiagnosis)
          .where(
            and(
              eq(encounterDiagnosis.organizationId, orgId),
              eq(encounterDiagnosis.patientId, patientId),
              eq(encounterDiagnosis.diagnosisCode, item.diagnosisCode),
              isNull(encounterDiagnosis.voidedAt),
              eq(encounterDiagnosis.status, "resuelto"),
              sameSite,
            ),
          )
          .limit(1)
    if (resolved) return false
    const suggestions = await getDiagnosisSuggestions(tx, orgId, { patientId, encounterId })
    const where = withSite(site, item)
    const proposal = suggestions.proposed.find(
      (candidate) =>
        candidate.source === "tratamiento" &&
        candidate.code === item.diagnosisCode &&
        (candidate.toothNumber ?? null) === (where.toothNumber ?? null),
    )
    if (!proposal?.diagnosisType) return false
    await recordEncounterDiagnosis(tx, orgId, actorUserId, patientId, encounterId, {
      diagnosisCode: proposal.code,
      diagnosisSystem: proposal.system,
      diagnosisType: proposal.diagnosisType,
      ...siteInput(proposal),
    })
    return true
  }
  if (!item.sourceEncounterId || item.sourceEncounterId === encounterId) return false
  const found = await activeIn(item.sourceEncounterId)
  return found ? record(found) : false
}

/**
 * «Hacer hoy»: el tratamiento aceptado pasa a esta atención,
 * como si lo trajera su cita. Si el motivo está vacío, queda «Continúa: …» (o su
 * nombre, si aún no empezó); el
 * diagnóstico que sigue se registra con su tipo (nunca lo sube a definitivo) y
 * lo ya escrito no se toca. No cuenta la sesión ni cambia el tratamiento: eso
 * es registrar su procedimiento. El consentimiento que pide ya se ve.
 */
export async function bringTreatmentToEncounter(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  planItemId: string,
): Promise<{ reasonSet: boolean; diagnosisAdded: boolean }> {
  const row = await openDraft(tx, orgId, actorUserId, patientId, encounterId)
  const [linkable] = await assertLinkablePlans(tx, orgId, patientId, [planItemId])
  if (!linkable) throw notFound("Ítem del plan")
  const [item] = await tx
    .select()
    .from(treatmentPlanItem)
    .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.id, planItemId)))
    .limit(1)
  if (!item) throw notFound("Ítem del plan")
  await tx
    .insert(encounterPlanItem)
    .values({ organizationId: orgId, encounterId, planItemId })
    .onConflictDoNothing({ target: [encounterPlanItem.encounterId, encounterPlanItem.planItemId] })
  const { site } = await productHooks(tx, orgId)
  if (linkable.toothNumber != null && site.system) {
    const code = site.code(linkable.toothNumber)
    if (code)
      await tx
        .insert(encounterSite)
        .values({ organizationId: orgId, encounterId, siteSystem: site.system, siteCode: code })
        .onConflictDoNothing()
  }
  // Ya empezó: tiene una sesión hecha en otra atención (la sesión 2 de la endodoncia).
  const started =
    item.status === "en_curso" ||
    (
      await tx.execute<{ id: string }>(sql`
        select done.id from encounter_procedure done
        join encounter done_encounter on done_encounter.organization_id = done.organization_id and done_encounter.id = done.encounter_id
        where done.organization_id = ${orgId} and done.plan_item_id = ${planItemId} and done.voided_at is null
          and done_encounter.status <> 'anulada' and done_encounter.id <> ${encounterId} limit 1`)
    ).length > 0
  let reasonSet = false
  if (!row.reason?.trim()) {
    await tx
      .update(encounter)
      .set({
        reason: (started ? continuesWords : startWords)(item.title, linkable.toothNumber).slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(and(eq(encounter.id, encounterId), eq(encounter.organizationId, orgId)))
    reasonSet = true
  }
  // El diagnóstico sigue solo con lo que ya empezó (la sesión 2 de la endodoncia): la corona que
  // se empieza semanas después no hereda la pulpitis (segunda mesa del 9 nov); su diagnóstico
  // propio, si lo tiene, se propone con «Usar».
  const diagnosisAdded = started && await continuingDiagnosis(
    tx,
    orgId,
    actorUserId,
    patientId,
    encounterId,
    item,
  )
  await audit(tx, orgId, actorUserId, "encounter.treatment_brought", encounterId, {
    patientId,
    planItemId,
  })
  return { reasonSet, diagnosisAdded }
}

/**
 * «Hoy no»: deshace «Hacer hoy» mientras no tenga su sesión registrada aquí: el
 * tratamiento deja de estar en esta atención. Lo escrito (motivo, diagnóstico)
 * queda como está: se corrige donde se ve.
 */
export async function leaveTreatmentFromEncounter(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  planItemId: string,
): Promise<void> {
  const row = await openDraft(tx, orgId, actorUserId, patientId, encounterId)
  const [registered] = await tx.execute<{ id: string }>(sql`
    select today.id from encounter_procedure today
    where today.organization_id = ${orgId} and today.encounter_id = ${encounterId}
      and today.plan_item_id = ${planItemId} and today.voided_at is null limit 1`)
  if (registered)
    throw conflict(
      "SESSION_REGISTERED",
      "Ya registraste su sesión de hoy: para quitarla, anula ese procedimiento",
    )
  if (row.appointmentId) {
    const [carried] = await tx.execute<{ id: string }>(sql`
      select brought.plan_item_id as id from appointment_plan_item brought
      where brought.organization_id = ${orgId} and brought.appointment_id = ${row.appointmentId}
        and brought.plan_item_id = ${planItemId} limit 1`)
    if (carried)
      throw conflict(
        "BROUGHT_BY_APPOINTMENT",
        "Lo trae su cita: si hoy no se hace, el cierre lo dice",
      )
  }
  await tx
    .delete(encounterPlanItem)
    .where(
      and(
        eq(encounterPlanItem.organizationId, orgId),
        eq(encounterPlanItem.encounterId, encounterId),
        eq(encounterPlanItem.planItemId, planItemId),
      ),
    )
  // El motivo que puso «Hacer hoy», si nadie lo cambió, se va con él; lo escrito se queda.
  const [item] = await tx
    .select({ title: treatmentPlanItem.title, siteSystem: treatmentPlanItem.siteSystem, siteCode: treatmentPlanItem.siteCode })
    .from(treatmentPlanItem)
    .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.id, planItemId)))
    .limit(1)
  if (item && row.reason) {
    const { site } = await productHooks(tx, orgId)
    const tooth = item.siteSystem === site.system ? site.value(item.siteCode) : null
    const put = [continuesWords(item.title, tooth), startWords(item.title, tooth)].map((words) => words.slice(0, 2000))
    if (put.includes(row.reason))
      await tx
        .update(encounter)
        .set({ reason: null, updatedAt: new Date() })
        .where(and(eq(encounter.id, encounterId), eq(encounter.organizationId, orgId)))
  }
  await audit(tx, orgId, actorUserId, "encounter.treatment_left", encounterId, {
    patientId,
    planItemId,
  })
}

/**
 * «Viene a su control»: el control por cumplir que es el de hoy (o ninguno con
 * `null`). Con el motivo vacío, queda el nombre del control, salvo que la cita de
 * esta atención ofrezca el suyo: ese sigue ofreciéndose con «Usar como motivo»
 * (QA en pantalla del 17 nov, D4). Se cumple recién al firmar, como lo demás del
 * cierre (ADR 0152).
 */
export async function chooseVisitControl(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  followUpId: string | null,
): Promise<{ reasonSet: boolean }> {
  const row = await openDraft(tx, orgId, actorUserId, patientId, encounterId)
  let title: string | null = null
  if (followUpId) {
    const { timezone } = await findOrgLocale(tx, orgId)
    const due = await dueControlsOf(tx, orgId, actorUserId, row, timezone)
    const control = due.find((candidate) => candidate.id === followUpId)
    if (!control)
      throw conflict(
        "CONTROL_NOT_DUE",
        "Ese control ya no está por cumplir: vuelve a cargar la atención",
      )
    title = control.title
  }
  const offered = title && !row.reason?.trim() ? await bookedReasonOf(tx, orgId, row.appointmentId) : null
  const reasonSet = Boolean(title && !row.reason?.trim() && !offered?.trim())
  await tx
    .update(encounter)
    .set({
      visitFollowUpId: followUpId,
      ...(reasonSet && title ? { reason: title.slice(0, 2000) } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(encounter.id, encounterId), eq(encounter.organizationId, orgId)))
  await audit(tx, orgId, actorUserId, "encounter.visit_control", encounterId, {
    patientId,
    followUpId,
  })
  return { reasonSet }
}
