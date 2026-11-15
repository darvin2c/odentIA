/**
 * «Antes de tu cita» (mesa de formularios del 13 nov, entrega 8): lo que la persona cuenta de su
 * visita antes de venir, una respuesta por cita (`appointment_visit_answer`). Lo que se le pregunta
 * lo marca la clínica en «Preguntas al paciente» (grupo «Antes de cada cita», `visitQuestionsOf`);
 * en una sesión o un control se le dice a qué viene y solo se le pregunta si le duele.
 *
 * Una sola regla para su enlace y su portal: lo responde quien decide por el paciente, para la
 * cita de «Antes de tu cita» (`beforeVisitAppointmentOf`: la de hoy mientras no termina o, si no,
 * la próxima), una vez. Lo que envió llega a «Hoy viene a…» de la atención de esa cita,
 * donde el sistema anota quién lo vio al atender, y queda en la Historia y en la copia de su
 * historia. Nada de esto traba la atención: sin respuesta, la atención se abre, se firma y se cobra.
 */
import {
  type HealthDeclarant,
  type VisitAnswer,
  type VisitAnswerInput,
  type VisitQuestions,
  asksAnything,
  visitAnswerHasContent,
  visitAnswerSchema,
  visitQuestionsOf,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { user } from "@odentia/db/schema/auth"
import { encounter } from "@odentia/db/schema/clinical"
import { appointmentVisitAnswer } from "@odentia/db/schema/clinical-forms"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm"
import { declarantOfContact } from "./clinical.js"
import { ServiceError, validation } from "./errors.js"
import { findOrgLocale } from "./locale.js"
import { getPatientRegistrationConfig } from "./patient-registration.js"
import { contactDecides } from "./responsibilities.js"
import { dayKeyIn } from "./to-schedule.js"

/** Lo que se le pregunta antes de una cita suya por venir. */
export interface VisitAsk {
  appointmentId: string
  startsAt: Date
  /** A qué viene, si ya se sabe (una sesión, un control): se le dice y no se le pregunta. */
  purpose: string | null
  questions: VisitQuestions
}

/** «Endodoncia anterior vital» → «endodoncia anterior vital»; una sigla («PRP») se queda como está. */
function lowerFirst(title: string): string {
  const text = title.trim()
  return text.length > 1 && text[1] === text[1]!.toLocaleLowerCase("es") ? text[0]!.toLocaleLowerCase("es") + text.slice(1) : text
}

/** «a», «a y b», «a, b y c». */
function joined(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} y ${parts.at(-1)}`
}

/**
 * A qué viene a esa cita, si la cita ya lo dice: los tratamientos que lleva («sesión 2 de
 * endodoncia»: la sesión que le toca, contando las ya hechas) y los controles que se reservaron con
 * ella. Nulo si es una cita sin nada de eso (una consulta, una urgencia): entonces se le pregunta.
 */
export async function appointmentPurposeOf(tx: Db, orgId: string, appointmentId: string): Promise<string | null> {
  const items = await tx.execute<{ title: string; m: number; done: number }>(sql`
    select i.title, i.planned_sessions as m,
      (select count(distinct p.encounter_id)::int from encounter_procedure p
        join encounter e on e.organization_id = p.organization_id and e.id = p.encounter_id
        where p.organization_id = i.organization_id and p.plan_item_id = i.id
          and p.voided_at is null and e.status <> 'anulada') as done
    from appointment_plan_item a
    join treatment_plan_item i on i.organization_id = a.organization_id and i.id = a.plan_item_id
    where a.organization_id = ${orgId} and a.appointment_id = ${appointmentId}
      and i.status not in ('cancelado', 'reemplazado')
    order by i.sort_order, i.created_at, i.id`)
  const controls = await tx.execute<{ title: string }>(sql`
    select title from clinical_follow_up
    where organization_id = ${orgId} and appointment_id = ${appointmentId} and status <> 'cancelado'
    order by created_at, id`)
  const words = [
    ...items.map((item) => {
      const n = Number(item.done) + 1
      const m = Number(item.m) || 1
      // «sesión 2 de endodoncia»: la de hoy, dicha como la lee la persona; una sola sesión, su nombre.
      return m > 1 || n > 1 ? `sesión ${n} de ${lowerFirst(item.title)}` : lowerFirst(item.title)
    }),
    ...controls.map((control) => lowerFirst(control.title)),
  ].filter(Boolean)
  return words.length > 0 ? joined([...new Set(words)]) : null
}

async function answerOf(tx: Db, orgId: string, appointmentId: string) {
  const [row] = await tx
    .select()
    .from(appointmentVisitAnswer)
    .where(and(eq(appointmentVisitAnswer.organizationId, orgId), eq(appointmentVisitAnswer.appointmentId, appointmentId)))
    .limit(1)
  return row ?? null
}

/**
 * Una cita suya que sigue en pie y no terminó: por venir o en curso (ya empezó y no terminó). La regla
 * de «Antes de tu cita», de «Tu visita» y de «¿Cambió algo?».
 */
export function unfinishedAppointmentOf(orgId: string, patientId: string, now: Date) {
  return and(
    eq(appointment.organizationId, orgId),
    eq(appointment.patientId, patientId),
    inArray(appointment.status, ["programada", "confirmada"]),
    gt(appointment.endsAt, now),
  )
}

/**
 * La cita de «Antes de tu cita» (QA final de formularios, 15 nov, H4): la que está en curso (suya,
 * en pie, ya empezó y no terminó) hasta que termina y, si no hay, la próxima en pie. Una sola regla
 * para su enlace, recepción y su portal: lo que cuenta en la sala de espera es de la cita a la que
 * vino, no de la del lunes. No es la cita que el enlace deja cambiar o cancelar: esa es solo la que
 * aún no empieza (`shownAppointment` de `booking-links.ts`).
 */
export async function beforeVisitAppointmentOf(
  tx: Db,
  orgId: string,
  patientId: string,
  now: Date = new Date(),
): Promise<{ id: string; startsAt: Date; endsAt: Date } | null> {
  const [row] = await tx
    .select({ id: appointment.id, startsAt: appointment.startsAt, endsAt: appointment.endsAt })
    .from(appointment)
    .where(unfinishedAppointmentOf(orgId, patientId, now))
    // La que está en curso empezó antes que cualquiera por venir.
    .orderBy(asc(appointment.startsAt), asc(appointment.id))
    .limit(1)
  return row ?? null
}

/**
 * Cuándo terminó su última visita, la última cita suya que ya terminó; una cancelada no fue una
 * visita. Nulo si no tuvo ninguna. Cuenta al terminar y no al empezar: mientras espera en la sala
 * (o se atiende), lo que envió sigue siendo de esta cita. Una sola regla para su enlace («Lo que
 * nos contaste») y recepción (`beforeVisitStatus`).
 */
export async function lastVisitAt(tx: Db, orgId: string, patientId: string, now: Date = new Date()): Promise<Date | null> {
  const [row] = await tx
    .select({ endsAt: appointment.endsAt })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.patientId, patientId),
        lte(appointment.endsAt, now),
        ne(appointment.status, "cancelada"),
      ),
    )
    .orderBy(desc(appointment.endsAt))
    .limit(1)
  return row?.endsAt ?? null
}

/**
 * Lo que se le pregunta de su visita antes de esa cita: solo si es suya, sigue en pie y no terminó
 * (por venir o en curso: en la sala de espera también se responde), la clínica pregunta algo y aún
 * no lo respondió. Nulo: nada que preguntar.
 */
export async function visitAskOf(
  tx: Db,
  orgId: string,
  input: { patientId: string; appointmentId: string | null },
  now: Date = new Date(),
): Promise<VisitAsk | null> {
  if (!input.appointmentId) return null
  const [row] = await tx
    .select({ id: appointment.id, startsAt: appointment.startsAt })
    .from(appointment)
    .where(and(eq(appointment.id, input.appointmentId), unfinishedAppointmentOf(orgId, input.patientId, now)))
    .limit(1)
  if (!row) return null
  if (await answerOf(tx, orgId, row.id)) return null
  const purpose = await appointmentPurposeOf(tx, orgId, row.id)
  const questions = visitQuestionsOf(await getPatientRegistrationConfig(tx, orgId), purpose)
  if (!asksAnything(questions)) return null
  return { appointmentId: row.id, startsAt: row.startsAt, purpose, questions }
}

/** Ya lo envió para esa cita: cuándo, y si fue quien abre (`own`) u otra persona que también decide por él. */
export async function visitSentOf(
  tx: Db,
  orgId: string,
  appointmentId: string | null,
  contactId: string,
): Promise<{ at: Date; own: boolean } | null> {
  if (!appointmentId) return null
  const row = await answerOf(tx, orgId, appointmentId)
  return row ? { at: row.submittedAt, own: row.respondentContactId === contactId } : null
}

/** Solo lo que se le preguntó, limpio: lo demás que llegue no se guarda. */
function onlyAsked(input: VisitAnswerInput, questions: VisitQuestions) {
  const text = (value: string | undefined) => (value?.trim() ? value.trim() : null)
  const pain = questions.pain ? (input.pain ?? null) : null
  return {
    reason: questions.reason ? text(input.reason) : null,
    pain,
    painLevel: pain === "si" ? (input.painLevel ?? null) : null,
    more: questions.more ? text(input.more) : null,
  }
}

/**
 * Lo envía quien decide por el paciente, desde su enlace o su portal, una vez por cita. Aunque no
 * cuente nada (todo es opcional) queda respondido: no se le vuelve a pedir para esa cita. Lo
 * enviado no cambia; si quiere cambiar algo, lo dice en la cita.
 */
export async function saveVisitAnswer(
  tx: Db,
  orgId: string,
  who: { patientId: string; contactId: string },
  appointmentId: string | null,
  input: unknown,
  via: "enlace" | "portal",
): Promise<{ sent: true }> {
  // La misma regla para el portal y su enlace: lo responde quien decide por el paciente.
  if (!(await contactDecides(tx, orgId, who.patientId, who.contactId)))
    throw new ServiceError("PORTAL_FORBIDDEN", 404, "Esto lo responde el paciente o quien decide por él")
  const parsed = visitAnswerSchema.safeParse(input ?? {})
  if (!parsed.success)
    throw validation("Revisa tus respuestas", Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join("."), issue.message])))
  const ask = await visitAskOf(tx, orgId, { patientId: who.patientId, appointmentId })
  if (!ask) {
    if (appointmentId && (await answerOf(tx, orgId, appointmentId))) throw alreadySent()
    throw new ServiceError("VISIT_NOT_ASKED", 404, "Para esta cita ya no hay nada que responder")
  }
  const [row] = await tx
    .insert(appointmentVisitAnswer)
    .values({
      organizationId: orgId,
      patientId: who.patientId,
      appointmentId: ask.appointmentId,
      ...onlyAsked(parsed.data, ask.questions),
      toldPurpose: ask.purpose,
      respondentContactId: who.contactId,
      submittedVia: via,
    })
    .onConflictDoNothing({ target: [appointmentVisitAnswer.organizationId, appointmentVisitAnswer.appointmentId] })
    .returning({ id: appointmentVisitAnswer.id })
  // Otra pestaña u otra persona lo envió un instante antes: lo primero es lo que queda.
  if (!row) throw alreadySent()
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: `contact:${who.contactId}`,
    action: "visit_answer.sent",
    entity: "appointment_visit_answer",
    entityId: row.id,
    metadata: { patientId: who.patientId, appointmentId: ask.appointmentId, via },
  })
  return { sent: true }
}

function alreadySent(): ServiceError {
  return new ServiceError(
    "ALREADY_SUBMITTED",
    409,
    "Ya lo enviaste: la clínica tiene lo que contaste para esta cita. Si quieres cambiar algo, dilo en la cita.",
  )
}

/** Lo que contó, como lo leen la atención, la Historia y la copia de su historia. */
export interface VisitAnswerView extends VisitAnswer {
  id: string
  appointmentId: string
  appointmentStartsAt: Date
  submittedAt: Date
  submittedVia: "enlace" | "portal"
  /** Quien lo envió: ella misma o quien decide por ella, con su vínculo. */
  by: HealthDeclarant
  /** Quién lo vio al atender y cuándo; nulo si nadie lo abrió todavía en una atención. */
  seen: { by: string; at: Date } | null
  /** La atención en que se vio, si sigue existiendo. */
  seenEncounterId: string | null
}

async function viewsOf(tx: Db, orgId: string, rows: Array<typeof appointmentVisitAnswer.$inferSelect>): Promise<VisitAnswerView[]> {
  if (rows.length === 0) return []
  const starts = new Map(
    (
      await tx
        .select({ id: appointment.id, startsAt: appointment.startsAt })
        .from(appointment)
        .where(and(eq(appointment.organizationId, orgId), inArray(appointment.id, rows.map((row) => row.appointmentId))))
    ).map((row) => [row.id, row.startsAt] as const),
  )
  const seers = [...new Set(rows.flatMap((row) => (row.seenBy ? [row.seenBy] : [])))]
  const names = new Map(
    seers.length > 0
      ? (await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, seers))).map((row) => [row.id, row.name] as const)
      : [],
  )
  const out: VisitAnswerView[] = []
  for (const row of rows) {
    out.push({
      id: row.id,
      appointmentId: row.appointmentId,
      appointmentStartsAt: starts.get(row.appointmentId) ?? row.submittedAt,
      reason: row.reason,
      pain: row.pain === "si" || row.pain === "no" ? row.pain : null,
      painLevel: row.painLevel,
      more: row.more,
      toldPurpose: row.toldPurpose,
      submittedAt: row.submittedAt,
      submittedVia: row.submittedVia === "portal" ? "portal" : "enlace",
      by: await declarantOfContact(tx, orgId, row.patientId, row.respondentContactId),
      seen: row.seenBy && row.seenAt ? { by: names.get(row.seenBy) ?? "el equipo", at: row.seenAt } : null,
      seenEncounterId: row.seenEncounterId,
    })
  }
  return out
}

/** Lo que contó, como lo lee la atención («Hoy viene a…» y la atención firmada). */
export interface EncounterVisitAnswer extends VisitAnswerView {
  /**
   * Lo contó para otra cita suya (la de `appointmentStartsAt`), no para la de esta atención: vino
   * sin cita, o antes de la cita para la que lo contó (QA final de formularios, 15 nov, H2). La
   * pantalla dice «Para su cita del lun 16 contó…».
   */
  otherAppointment: boolean
}

interface EncounterForVisit {
  id: string
  patientId: string
  appointmentId: string | null
  professionalUserId: string
  status: string
  startedAt: Date
}

/** La atención sigue viva: existe y no se anuló. */
async function encounterAlive(tx: Db, orgId: string, encounterId: string): Promise<boolean> {
  const [row] = await tx
    .select({ status: encounter.status })
    .from(encounter)
    .where(and(eq(encounter.organizationId, orgId), eq(encounter.id, encounterId)))
    .limit(1)
  return !!row && row.status !== "anulada"
}

/**
 * Lo que contó para la cita de esta atención, si contó algo y no lo vio ya alguien en otra
 * atención que sigue viva: si vino antes sin cita y ahí se leyó, el día de su cita ya no se
 * repite como de hoy.
 */
async function ownAnswerOf(tx: Db, orgId: string, row: EncounterForVisit) {
  if (!row.appointmentId) return null
  const answer = await answerOf(tx, orgId, row.appointmentId)
  if (!answer || answer.patientId !== row.patientId || !visitAnswerHasContent(answer)) return null
  if (answer.seenEncounterId && answer.seenEncounterId !== row.id && (await encounterAlive(tx, orgId, answer.seenEncounterId)))
    return null
  return answer
}

/**
 * Lo que contó para otra cita suya, cuando esta atención no tiene cita o su cita no trae nada (QA
 * final de formularios, 15 nov, H2: Rosa contó para su cita del lunes y vino hoy). Lo que ya se vio
 * en esta atención sigue en ella, también firmada. Si no, solo en un borrador de hoy: lo de una cita
 * suya que sigue en pie y no terminó, que nadie vio en otra atención viva; la más cercana. Una
 * atención que se registra otro día no lo toma: no es la visita a la que venía.
 */
async function toldForAnotherVisit(tx: Db, orgId: string, row: EncounterForVisit, now: Date) {
  const rows = await tx
    .select({
      answer: appointmentVisitAnswer,
      status: appointment.status,
      endsAt: appointment.endsAt,
      seenStatus: encounter.status,
    })
    .from(appointmentVisitAnswer)
    .innerJoin(
      appointment,
      and(eq(appointment.organizationId, appointmentVisitAnswer.organizationId), eq(appointment.id, appointmentVisitAnswer.appointmentId)),
    )
    .leftJoin(
      encounter,
      and(eq(encounter.organizationId, appointmentVisitAnswer.organizationId), eq(encounter.id, appointmentVisitAnswer.seenEncounterId)),
    )
    .where(
      and(
        eq(appointmentVisitAnswer.organizationId, orgId),
        eq(appointmentVisitAnswer.patientId, row.patientId),
        row.appointmentId ? ne(appointmentVisitAnswer.appointmentId, row.appointmentId) : undefined,
      ),
    )
    .orderBy(asc(appointment.startsAt), asc(appointment.id))
  const told = rows.filter((item) => visitAnswerHasContent(item.answer))
  const here = told.find((item) => item.answer.seenEncounterId === row.id)
  if (here) return here.answer
  if (row.status !== "borrador") return null
  const { timezone } = await findOrgLocale(tx, orgId)
  if (dayKeyIn(row.startedAt, timezone) !== dayKeyIn(now, timezone)) return null
  return (
    told.find(
      (item) =>
        (item.status === "programada" || item.status === "confirmada") &&
        item.endsAt > now &&
        (!item.answer.seenEncounterId || item.seenStatus === null || item.seenStatus === "anulada"),
    )?.answer ?? null
  )
}

/**
 * «Hoy viene a…»: lo que contó para la cita de esta atención o, si no trae nada, lo que contó para
 * otra cita suya que aún no llega (`otherAppointment`, con su fecha). Si quien atiende abre su
 * borrador, el sistema anota que lo vio (quién, cuándo y en esta atención), una sola vez y sin
 * botón; así, el día de esa otra cita ya no sale como de hoy. Una respuesta en blanco no se
 * muestra. Nulo si no hay nada que contar.
 */
export async function encounterVisitAnswer(
  tx: Db,
  orgId: string,
  row: EncounterForVisit,
  viewerUserId: string | null,
  now: Date = new Date(),
): Promise<EncounterVisitAnswer | null> {
  let answer = (await ownAnswerOf(tx, orgId, row)) ?? (await toldForAnotherVisit(tx, orgId, row, now))
  if (!answer) return null
  if (row.status === "borrador" && viewerUserId && viewerUserId === row.professionalUserId && !answer.seenAt) {
    const [seen] = await tx
      .update(appointmentVisitAnswer)
      .set({ seenBy: viewerUserId, seenAt: new Date(), seenEncounterId: row.id })
      .where(and(eq(appointmentVisitAnswer.organizationId, orgId), eq(appointmentVisitAnswer.id, answer.id), isNull(appointmentVisitAnswer.seenAt)))
      .returning()
    if (seen) answer = seen
  }
  const [view] = await viewsOf(tx, orgId, [answer])
  return view ? { ...view, otherAppointment: answer.appointmentId !== row.appointmentId } : null
}

/**
 * Todo lo que contó antes de sus citas, la más reciente primero, con la atención en que se leyó (la
 * de esa cita o, si vino antes, la de ese día) si la tuvo: lo lee la Historia y la copia de su
 * historia. Lo que quedó en blanco no cuenta; lo que aún no tiene atención va suelto.
 */
export async function patientVisitAnswers(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<Array<VisitAnswerView & { encounterId: string | null }>> {
  const rows = await tx
    .select()
    .from(appointmentVisitAnswer)
    .where(and(eq(appointmentVisitAnswer.organizationId, orgId), eq(appointmentVisitAnswer.patientId, patientId)))
    .orderBy(desc(appointmentVisitAnswer.submittedAt))
  const told = rows.filter((row) => visitAnswerHasContent(row))
  const views = await viewsOf(tx, orgId, told)
  if (views.length === 0) return []
  const seenIds = views.flatMap((view) => (view.seenEncounterId ? [view.seenEncounterId] : []))
  const encounters = await tx
    .select({ id: encounter.id, appointmentId: encounter.appointmentId, status: encounter.status })
    .from(encounter)
    .where(
      and(
        eq(encounter.organizationId, orgId),
        eq(encounter.patientId, patientId),
        or(
          inArray(encounter.appointmentId, views.map((view) => view.appointmentId)),
          seenIds.length > 0 ? inArray(encounter.id, seenIds) : undefined,
        ),
      ),
    )
  const alive = encounters.filter((item) => item.status !== "anulada")
  return views.map((view) => {
    // Lo visto en una atención viva va en ella, aunque sea de otra cita (vino antes, sin cita);
    // si no, en la de su cita.
    const seen = alive.find((item) => item.id === view.seenEncounterId)
    const own = alive.find((item) => item.appointmentId === view.appointmentId)
    return { ...view, encounterId: (seen ?? own)?.id ?? null }
  })
}
