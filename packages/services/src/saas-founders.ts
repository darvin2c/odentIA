import { createHash, randomBytes } from "node:crypto"
import { CLINICAL_PRODUCTS, type ClinicalProduct, isClinicalProduct, productWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { saasClient } from "@odentia/db/schema/admin-arm"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import { organization, user } from "@odentia/db/schema/auth"
import {
  SAAS_WAITLIST_PROFESSIONALS,
  SAAS_WAITLIST_STATUSES,
  SAAS_WAITLIST_TOOLS,
  type SaasWaitlistStatus,
  saasFollowUp,
  saasPayment,
  saasPlan,
  saasSubscription,
  saasWaitlistRequest,
} from "@odentia/db/schema/saas-billing"
import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, lte, ne, or, type SQL, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { z } from "zod"
import { planPrices } from "./saas-actions.js"
import { clientForWaitlistRequest, linkClientToOrganization } from "./admin-clients.js"
import { applyInvitedProposal } from "./admin-sales.js"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import { addBusinessDays, currentSaasTerms, loadSaasTermsTimeline, type SaasTermsTimeline, saasTermsAt } from "./saas-commercial-terms.js"
import { invalidField, notFound, ServiceError, validation } from "./errors.js"
import { orgProduct } from "./locale.js"
import { guideSheetsFor } from "./products.js"
import { limaDate } from "./peru-business-days.js"
import { defaultPlanOf } from "./saas-plan-product.js"

/**
 * Las solicitudes y la invitación del ARM, los planes especiales y los precios públicos.
 * El alta es libre (ADR 0221): cualquiera abre su clínica en la prueba del plan de lista.
 * La invitación ya no hace falta para entrar: es como la administración le manda a un
 * cliente lo que negoció, que se aplica al abrir su clínica. El programa Fundadores
 * terminó; su plan sigue como un plan especial, oculto de la web.
 *
 * Todo vive en tablas de la plataforma que solo toca `ownerDb`.
 */

const DAY = 86_400_000
/** La invitación vale 14 días (decisión 8); reenviarla da otros 14. */
export const FOUNDER_INVITATION_DAYS = 14

export type { SaasWaitlistStatus }
export { SAAS_WAITLIST_PROFESSIONALS, SAAS_WAITLIST_STATUSES, SAAS_WAITLIST_TOOLS }
export { founderInvitationEmail, moneyText, webContactEmail } from "./saas-emails.js"

/* ---------- La página de la web de donde viene algo ---------- */

/** Una página de la web, como se guarda (ADR 0216): «/guias/como-llenar-un-odontograma». */
const WEB_PAGE = /^\/[a-z0-9-]+(\/[a-z0-9-]+)*$/

/**
 * La página desde la que se envió algo, comprobada: una ruta de la web y nada más (nunca
 * un título que mande el navegador). Lo que no lo es se deja fuera, sin rechazar el envío.
 */
export function webPageOf(value: unknown): string | null {
  if (typeof value !== "string") return null
  const page = value.trim()
  return page.length <= 160 && WEB_PAGE.test(page) ? page : null
}

/* ---------- Etapas de una solicitud ---------- */

/**
 * La etapa de una solicitud se calcula al leer: nadie la mueve a mano. Sale de
 * su estado guardado, del vencimiento de la invitación y de los pagos de su
 * clínica.
 */
export const WAITLIST_STAGES = ["por_revisar", "invitada", "invitacion_vencida", "entro", "paga", "descartada"] as const
export type WaitlistStage = (typeof WAITLIST_STAGES)[number]

/**
 * La etapa de una solicitud. Una invitada cuyo enlace ya venció está en
 * «Invitación vencida». Una que entró está en «Paga» solo si su clínica tiene
 * al menos un pago confirmado (`paid`, ver `paidSql`): la suscripción «activa»
 * no basta, porque el ciclo la activa sin cobrar nada. Gracia, restringida,
 * pausada, cancelada, demo, Fundadores sin cuota y la clínica borrada siguen
 * en «Entró».
 */
export function waitlistStage(row: { status: string; inviteExpiresAt: Date | null }, paid: boolean, now: Date): WaitlistStage {
  if (row.status === "invitada") return row.inviteExpiresAt !== null && row.inviteExpiresAt <= now ? "invitacion_vencida" : "invitada"
  if (row.status === "entro") return paid ? "paga" : "entro"
  if (row.status === "descartada") return "descartada"
  return "por_revisar"
}

/** ¿Su clínica tiene al menos un pago confirmado? Sin clínica (la borraron) o si es una demo, no. */
const paidSql = sql<boolean>`(${saasWaitlistRequest.organizationId} is not null
  and not exists (select 1 from ${saasDemo} d where d.organization_id = ${saasWaitlistRequest.organizationId})
  and exists (select 1 from ${saasPayment} p where p.organization_id = ${saasWaitlistRequest.organizationId} and p.status = 'confirmado'))`

/** La misma regla de `waitlistStage`, en SQL: filtra y cuenta sin que el tope de filas la corte. */
function stageSql(now: Date): SQL<WaitlistStage> {
  return sql<WaitlistStage>`(case
    when ${saasWaitlistRequest.status} = 'invitada' and ${saasWaitlistRequest.inviteExpiresAt} <= ${now.toISOString()}::timestamptz then 'invitacion_vencida'
    when ${saasWaitlistRequest.status} = 'entro' and ${paidSql} then 'paga'
    else ${saasWaitlistRequest.status} end)`
}

/* ---------- El seguimiento de una solicitud ---------- */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Hasta cuántos días adelante se puede poner «Volver a contactar». */
const FOLLOW_UP_MAX_DAYS = 365
/** Las invitaciones salen en Inicio cuando les faltan estos días o ya vencieron. */
const INVITE_SOON_DAYS = 3

const isoDay = (date: Date) => date.toISOString().slice(0, 10)
/** El día civil `day` («2026-11-12») como medianoche UTC, para sumarle días. */
const dayStart = (day: string) => new Date(`${day}T00:00:00Z`)

/**
 * Las fechas que se ofrecen para volver a contactar. «Hoy» es el día civil de
 * America/Lima (`limaDate`), donde trabaja el equipo: a las 19:30 del
 * miércoles en Lima ya es jueves en UTC, y sigue siendo miércoles.
 */
export interface FollowUpChoices {
  /** Hoy, en America/Lima. */
  today: string
  tomorrow: string
  /** En 3 días hábiles (de lunes a viernes, como el plazo para responder). */
  inThreeBusinessDays: string
  /** La próxima semana: el mismo día, dentro de 7. */
  nextWeek: string
  /** El último día que se acepta: hoy y un año. */
  latest: string
}

export function followUpChoices(now = new Date()): FollowUpChoices {
  // «Hoy» en America/Lima.
  const today = limaDate(now)
  const start = dayStart(today)
  const plus = (days: number) => isoDay(new Date(start.getTime() + days * DAY))
  return {
    today,
    tomorrow: plus(1),
    inThreeBusinessDays: isoDay(addBusinessDays(start, 3)),
    nextWeek: plus(7),
    latest: plus(FOLLOW_UP_MAX_DAYS),
  }
}

/**
 * Qué le toca al equipo con una solicitud, para la columna Plazo, la cabecera
 * del cajón e Inicio (el mismo dato en los tres):
 * - `por_responder`: nadie le respondió todavía; su plazo vencido, de hoy o
 *   hasta un día. Anotar un contacto cuenta como haberle respondido; una nota
 *   de antes (`from_note`) no.
 * - `contactada`: ya se anotó un contacto y no hay fecha para volver; el día
 *   es el del último contacto.
 * - `volver`: el día (de Lima) en que hay que volver a contactarla.
 * La invitación no va aquí: su vencimiento lo dice `inviteExpiresAt`.
 */
export type WaitlistAnswer =
  | { kind: "por_responder"; due: "vencida" | "hoy" | "hasta"; by: Date; day: string }
  | { kind: "contactada"; day: string }
  | { kind: "volver"; day: string }

export function waitlistAnswer(
  row: { status: string; answerBy: Date | null; lastContactAt: Date | null; nextFollowUpOn: string | null },
  now: Date,
): WaitlistAnswer | null {
  // Descartar cierra el seguimiento.
  if (row.status === "descartada") return null
  if (row.nextFollowUpOn) return { kind: "volver", day: row.nextFollowUpOn }
  if (row.status !== "por_revisar") return null
  if (row.lastContactAt) return { kind: "contactada", day: limaDate(row.lastContactAt) }
  if (!row.answerBy) return null
  const day = limaDate(row.answerBy)
  return { kind: "por_responder", due: row.answerBy < now ? "vencida" : day === limaDate(now) ? "hoy" : "hasta", by: row.answerBy, day }
}

/** La última entrada de cada solicitud: la que dice la próxima acción (`follow_up_on`). */
const lastEntry = alias(saasFollowUp, "last_follow_up")
const lastAuthor = alias(user, "last_follow_up_author")
const isLastEntry = sql`${lastEntry.id} = (select f.id from ${saasFollowUp} f where f.request_id = ${saasWaitlistRequest.id}
  order by f.created_at desc, f.id desc limit 1)`

/**
 * El último contacto anotado: una entrada que no es una nota de antes
 * (`from_note`: la «Nota del equipo» trasladada o la de la ruta vieja).
 */
const lastContactAtSql = sql<Date | null>`(select max(f.created_at) from ${saasFollowUp} f
  where f.request_id = ${saasWaitlistRequest.id} and not f.from_note)`.mapWith(saasFollowUp.createdAt)

/** Nadie le respondió: por revisar y sin ningún contacto anotado (anotar un contacto ya es responderle; una nota, no). */
const toAnswerSql = and(
  eq(saasWaitlistRequest.status, "por_revisar"),
  sql`not exists (select 1 from ${saasFollowUp} f where f.request_id = ${saasWaitlistRequest.id} and not f.from_note)`,
)
/** Invitada con el enlace que vence en 3 días o ya venció. */
const invitationSoonSql = (now: Date) =>
  and(eq(saasWaitlistRequest.status, "invitada"), lte(saasWaitlistRequest.inviteExpiresAt, new Date(now.getTime() + INVITE_SOON_DAYS * DAY)))
/** La misma regla de `invitationSoonSql`, para una fila ya leída. */
const invitationSoon = (row: { status: string; inviteExpiresAt: Date | null }, now: Date) =>
  row.status === "invitada" && row.inviteExpiresAt !== null && row.inviteExpiresAt.getTime() <= now.getTime() + INVITE_SOON_DAYS * DAY

/* ---------- La lista en la administración ---------- */

export interface WaitlistRow {
  id: string
  firstName: string
  lastName: string
  email: string
  phone: string
  clinicName: string
  countryCode: string
  city: string
  professionals: string
  currentTool: string
  /** odentIA o latidIA: la clínica nace con él y la invitación abre su panel. */
  product: ClinicalProduct
  /** La página de la web desde la que se envió, si no fue la de la solicitud: «Llegó desde». */
  sourcePage: string | null
  status: SaasWaitlistStatus
  /** La etapa, calculada al leer (`waitlistStage`). */
  stage: WaitlistStage
  discardReason: string | null
  planId: string | null
  planName: string | null
  inviteExpiresAt: Date | null
  invitedAt: Date | null
  organizationId: string | null
  organizationName: string | null
  enteredAt: Date | null
  decidedByName: string | null
  createdAt: Date
  /** Por revisar: el último instante para responder (los días hábiles que regían al llegar, de lunes a viernes). */
  answerBy: Date | null
  /** Qué le toca al equipo (`waitlistAnswer`). */
  answer: WaitlistAnswer | null
  /** El día de Lima para volver a contactarla: el de su última entrada. Nulo sin fecha o descartada. */
  nextFollowUpOn: string | null
  /**
   * Esa fecha la dejó una entrada solo de administración: a soporte no le sale
   * en su Inicio (`waitlistHomeRows`), así que su lista y su cajón no la dicen
   * como algo que le toca.
   */
  nextFollowUpAdminOnly: boolean
  /**
   * Invitada con el enlace que vence en 3 días o ya venció: sale en Inicio, en
   * «Prospectos por responder», haya o no seguimiento, hasta reenviarla, que
   * entre o descartarla.
   */
  invitationSoon: boolean
}

/**
 * La constancia de una clínica que la administración pasó a un plan especial desde su prueba
 * (`moveClinicToSpecialPlan`): no deja pasarla otra vez. El nombre de la acción queda como
 * estaba para que la auditoría vieja se siga leyendo igual.
 */
export const FOUNDERS_ENTERED_ACTION = "saas.founders_entered"

/**
 * Las solicitudes como filas de la lista, con su etapa y lo que le toca al
 * equipo: una sola lectura para la lista, el cajón y la invitación recién
 * enviada.
 */
async function readWaitlistRows(
  tx: Db,
  where: SQL | undefined,
  now: Date,
  options: { orderBy?: SQL[]; limit?: number } = {},
): Promise<WaitlistRow[]> {
  const decider = sql<string | null>`(select ${user.name} from ${user} where ${user.id} = ${saasWaitlistRequest.decidedBy})`
  let query = tx
    .select({
      row: saasWaitlistRequest,
      planName: saasPlan.name,
      organizationName: organization.name,
      decidedByName: decider,
      paid: paidSql,
      lastContactAt: lastContactAtSql,
      lastFollowUpOn: lastEntry.followUpOn,
      lastAdminOnly: lastEntry.adminOnly,
    })
    .from(saasWaitlistRequest)
    .leftJoin(saasPlan, eq(saasPlan.id, saasWaitlistRequest.planId))
    .leftJoin(organization, eq(organization.id, saasWaitlistRequest.organizationId))
    .leftJoin(lastEntry, isLastEntry)
    .where(where)
    .$dynamic()
  if (options.orderBy) query = query.orderBy(...options.orderBy)
  if (options.limit) query = query.limit(options.limit)
  const rows = await query
  const timeline = await loadSaasTermsTimeline(tx)
  return rows.map((found) => toWaitlistRow(found, timeline, now))
}

function toWaitlistRow(
  found: {
    row: typeof saasWaitlistRequest.$inferSelect
    planName: string | null
    organizationName: string | null
    decidedByName: string | null
    paid: boolean
    lastContactAt: Date | null
    lastFollowUpOn: string | null
    lastAdminOnly: boolean | null
  },
  timeline: SaasTermsTimeline,
  now: Date,
): WaitlistRow {
  const { row } = found
  const answerBy = row.status === "por_revisar" ? addBusinessDays(row.createdAt, timeline.at(row.createdAt).waitlistAnswerDays) : null
  // Descartar cierra el seguimiento: su última fecha ya no cuenta.
  const nextFollowUpOn = row.status === "descartada" ? null : found.lastFollowUpOn
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    clinicName: row.clinicName,
    countryCode: row.countryCode,
    city: row.city,
    professionals: row.professionals,
    currentTool: row.currentTool,
    product: isClinicalProduct(row.product) ? row.product : "dental",
    sourcePage: row.sourcePage,
    status: row.status as SaasWaitlistStatus,
    stage: waitlistStage(row, found.paid, now),
    discardReason: row.discardReason,
    planId: row.planId,
    planName: found.planName,
    inviteExpiresAt: row.inviteExpiresAt,
    invitedAt: row.invitedAt,
    organizationId: row.organizationId,
    organizationName: found.organizationName,
    enteredAt: row.enteredAt,
    decidedByName: found.decidedByName,
    createdAt: row.createdAt,
    answerBy,
    answer: waitlistAnswer({ status: row.status, answerBy, lastContactAt: found.lastContactAt, nextFollowUpOn }, now),
    nextFollowUpOn,
    nextFollowUpAdminOnly: nextFollowUpOn !== null && found.lastAdminOnly === true,
    invitationSoon: invitationSoon(row, now),
  }
}

async function lockRequest(tx: Db, id: string) {
  if (!UUID.test(id)) throw notFound("Solicitud")
  const [row] = await tx.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.id, id)).limit(1).for("update")
  if (!row) throw notFound("Solicitud")
  return row
}

/** Una entrada del seguimiento, como la lee cada rol. */
export interface WaitlistFollowUpEntry {
  id: string
  /** Quien la anotó; nulo es «Nota anterior, sin autor registrado». */
  authorName: string | null
  /** Lo que pasó. Para soporte, nulo en una entrada solo de administración. */
  body: string | null
  /** El día de Lima para volver a contactar que dejó esta entrada. */
  followUpOn: string | null
  adminOnly: boolean
  /** Una «Nota del equipo» de antes: no es un contacto ni cuenta como haberle respondido. */
  fromNote: boolean
  createdAt: Date
}

export interface WaitlistRequestDetail {
  request: WaitlistRow
  /** Las entradas, la más nueva arriba. */
  entries: WaitlistFollowUpEntry[]
  /** Las fechas que se ofrecen hoy para volver a contactarla. */
  choices: FollowUpChoices
}

/**
 * Una solicitud con su seguimiento, para su cajón: no depende de la etapa ni
 * del producto que mira la lista. Soporte ve que hay una entrada solo de
 * administración, y su fecha, pero no lo que dice.
 */
export async function getWaitlistRequest(tx: Db, actor: AdminActor, id: string, now = new Date()): Promise<WaitlistRequestDetail> {
  if (!UUID.test(id)) throw notFound("Solicitud")
  const [request] = await readWaitlistRows(tx, eq(saasWaitlistRequest.id, id), now)
  if (!request) throw notFound("Solicitud")
  const entries = await tx
    .select({
      id: saasFollowUp.id,
      authorName: user.name,
      body: saasFollowUp.body,
      followUpOn: saasFollowUp.followUpOn,
      adminOnly: saasFollowUp.adminOnly,
      fromNote: saasFollowUp.fromNote,
      createdAt: saasFollowUp.createdAt,
    })
    .from(saasFollowUp)
    .leftJoin(user, eq(user.id, saasFollowUp.authorUserId))
    .where(eq(saasFollowUp.requestId, id))
    .orderBy(desc(saasFollowUp.createdAt), desc(saasFollowUp.id))
  return {
    request,
    entries: entries.map((entry) => ({ ...entry, body: entry.adminOnly && actor.role !== "admin" ? null : entry.body })),
    choices: followUpChoices(now),
  }
}

export interface WaitlistFollowUpInput {
  body: string
  /** El día de Lima para volver a contactar, de hoy a un año; nulo cierra el recordatorio. */
  followUpOn?: string | null
  /** Solo la lee el rol Administración. Lo que anota soporte nunca lo es. */
  adminOnly?: boolean
}

/** El día para volver, si sirve: un día real entre hoy (en Lima) y un año. */
function checkFollowUpOn(day: string | null, now: Date): string | null {
  if (day === null) return null
  const { today, latest } = followUpChoices(now)
  // «2026-13-01» pasa la forma pero no es una fecha: sin mirar antes, toISOString lanzaría.
  const start = ISO_DAY.test(day) ? dayStart(day) : null
  const real = start !== null && !Number.isNaN(start.getTime()) && isoDay(start) === day
  if (!real || day < today || day > latest) throw invalidField("followUpOn", "Elige un día desde hoy hasta dentro de un año")
  return day
}

async function insertFollowUp(
  tx: Db,
  actor: AdminActor,
  requestId: string,
  entry: { body: string; followUpOn: string | null; adminOnly: boolean; fromNote?: boolean },
  now: Date,
): Promise<WaitlistFollowUpEntry> {
  const [row] = await tx
    .insert(saasFollowUp)
    .values({
      requestId,
      authorUserId: actor.userId,
      body: entry.body,
      followUpOn: entry.followUpOn,
      adminOnly: entry.adminOnly,
      fromNote: entry.fromNote ?? false,
      createdAt: now,
    })
    .returning()
  if (!row) throw new ServiceError("INTERNAL", 409, "No se pudo anotar el seguimiento")
  await tx.update(saasWaitlistRequest).set({ updatedAt: now }).where(eq(saasWaitlistRequest.id, requestId))
  // La auditoría dice qué se anotó, nunca el texto.
  await writeAdminAudit(tx, actor, {
    action: "saas.waitlist_follow_up",
    entityId: requestId,
    metadata: { entryId: row.id, followUpOn: entry.followUpOn, adminOnly: entry.adminOnly },
  })
  const [author] = await tx.select({ name: user.name }).from(user).where(eq(user.id, actor.userId)).limit(1)
  return {
    id: row.id,
    authorName: author?.name ?? null,
    body: row.body,
    followUpOn: row.followUpOn,
    adminOnly: row.adminOnly,
    fromNote: row.fromNote,
    createdAt: row.createdAt,
  }
}

/**
 * Anota un contacto con la clínica: lo que pasó y, si hay que volver, el día
 * de Lima en que se vuelve a contactar. La próxima acción es la fecha de la
 * última entrada: sin fecha, el recordatorio se cierra. Las entradas solo se
 * agregan (`saas_follow_up_append_only`).
 */
export async function addWaitlistFollowUp(
  tx: Db,
  actor: AdminActor,
  id: string,
  input: WaitlistFollowUpInput,
  now = new Date(),
): Promise<WaitlistFollowUpEntry> {
  const body = typeof input.body === "string" ? input.body.trim() : ""
  if (!body) throw invalidField("body", "Escribe qué pasó")
  if (body.length > 2000) throw invalidField("body", "Usa como máximo 2000 caracteres")
  const followUpOn = checkFollowUpOn(input.followUpOn ?? null, now)
  const row = await lockRequest(tx, id)
  if (row.status === "descartada" && followUpOn) {
    throw invalidField("followUpOn", "La solicitud está descartada: su seguimiento quedó cerrado y no vuelve a salir en Inicio")
  }
  // Lo que anota soporte siempre lo lee el equipo entero.
  const adminOnly = actor.role === "admin" ? Boolean(input.adminOnly) : false
  return insertFollowUp(tx, actor, id, { body, followUpOn, adminOnly }, now)
}

/** Oculta una entrada a soporte: pasa a ser solo de administración, y no se deshace. */
export async function hideWaitlistFollowUp(tx: Db, actor: AdminActor, entryId: string): Promise<void> {
  if (actor.role !== "admin") throw new ServiceError("FORBIDDEN", 403, "Solo el rol Administración oculta una entrada a soporte")
  if (!UUID.test(entryId)) throw notFound("Entrada")
  const [entry] = await tx
    .select({ id: saasFollowUp.id, requestId: saasFollowUp.requestId, organizationId: saasFollowUp.organizationId, adminOnly: saasFollowUp.adminOnly })
    .from(saasFollowUp)
    .where(eq(saasFollowUp.id, entryId))
    .limit(1)
    .for("update")
  if (!entry) throw notFound("Entrada")
  if (entry.adminOnly) return
  await tx.update(saasFollowUp).set({ adminOnly: true }).where(eq(saasFollowUp.id, entryId))
  await writeAdminAudit(tx, actor, {
    action: "saas.waitlist_follow_up_hidden",
    organizationId: entry.organizationId,
    entityId: entry.requestId,
    metadata: { entryId },
  })
}

/* ---------- Prospectos en Inicio de la administración ---------- */

export interface WaitlistHomeFollowUp {
  /** El día de Lima en que tocaba volver a contactarla. */
  on: string
  /** Ya pasó ese día («Tocaba el…»); si no, es hoy («Toca hoy»). */
  overdue: boolean
  /** Lo que se anotó la última vez. */
  body: string
  /** Quien lo anotó; nulo es «Nota anterior, sin autor registrado». */
  authorName: string | null
  createdAt: Date
}

/**
 * Una fila por solicitud en Inicio. Sale en «Prospectos por responder»
 * (`reason`) si nadie le respondió o si su invitación vence en 3 días o ya
 * venció; y en «Seguimientos de hoy» si la fecha de su última entrada es hoy
 * o ya pasó. Si sale por las dos cosas, es una sola fila: el seguimiento va
 * como su segunda línea.
 */
export interface WaitlistHomeRow {
  id: string
  clinicName: string
  firstName: string
  lastName: string
  product: ClinicalProduct
  stage: WaitlistStage
  /** Por qué está en «Prospectos por responder»; nulo si solo sale por su seguimiento. */
  reason: "por_responder" | "invitacion" | null
  /** Por responder: su plazo («Respuesta vencida el…», «Responder hoy», «Responder hasta el…»). */
  answer: Extract<WaitlistAnswer, { kind: "por_responder" }> | null
  /** Invitada: cuándo vence o venció su enlace. */
  inviteExpiresAt: Date | null
  /** El seguimiento que toca hoy o ya tocaba; nulo si no hay o si este rol no lo puede leer. */
  followUp: WaitlistHomeFollowUp | null
  /** Algo ya venció: va arriba. */
  overdue: boolean
}

/**
 * Los prospectos que esperan al equipo hoy: por responder, invitaciones que
 * vencen y seguimientos que tocan. Sin las descartadas, que cerraron su
 * seguimiento. A soporte no le llega lo que es solo de administración: ni el
 * texto ni la fila. Lo vencido arriba; después, lo que vence antes.
 */
export async function waitlistHomeRows(tx: Db, actor: AdminActor, now = new Date()): Promise<WaitlistHomeRow[]> {
  // «Hoy» en America/Lima.
  const today = limaDate(now)
  const readsAll = actor.role === "admin"
  const followUpDue = and(
    ne(saasWaitlistRequest.status, "descartada"),
    lte(lastEntry.followUpOn, today),
    readsAll ? undefined : eq(lastEntry.adminOnly, false),
  )
  const rows = await tx
    .select({
      row: saasWaitlistRequest,
      paid: paidSql,
      lastContactAt: lastContactAtSql,
      entryId: lastEntry.id,
      entryBody: lastEntry.body,
      entryOn: lastEntry.followUpOn,
      entryAdminOnly: lastEntry.adminOnly,
      entryAt: lastEntry.createdAt,
      entryAuthor: lastAuthor.name,
    })
    .from(saasWaitlistRequest)
    .leftJoin(lastEntry, isLastEntry)
    .leftJoin(lastAuthor, eq(lastAuthor.id, lastEntry.authorUserId))
    .where(or(toAnswerSql, invitationSoonSql(now), followUpDue))
  const timeline = await loadSaasTermsTimeline(tx)
  const out: { item: WaitlistHomeRow; dueAt: number }[] = []
  for (const found of rows) {
    const { row } = found
    // Una nota de antes no es haberle respondido: sigue por responder.
    const toAnswer = row.status === "por_revisar" && found.lastContactAt === null
    const invitation = invitationSoon(row, now)
    const readable = found.entryId !== null && (readsAll || !found.entryAdminOnly)
    const due = readable && row.status !== "descartada" && found.entryOn !== null && found.entryOn <= today
    if (!toAnswer && !invitation && !due) continue
    const answerBy = toAnswer ? addBusinessDays(row.createdAt, timeline.at(row.createdAt).waitlistAnswerDays) : null
    const answer = waitlistAnswer({ status: row.status, answerBy, lastContactAt: null, nextFollowUpOn: null }, now)
    const followUp: WaitlistHomeFollowUp | null =
      due && found.entryOn && found.entryBody !== null && found.entryAt
        ? { on: found.entryOn, overdue: found.entryOn < today, body: found.entryBody, authorName: found.entryAuthor, createdAt: found.entryAt }
        : null
    const dueAts = [
      answerBy?.getTime(),
      invitation ? row.inviteExpiresAt?.getTime() : undefined,
      // El día de Lima empieza a las 05:00 UTC (America/Lima no cambia de hora desde 1994).
      followUp ? new Date(`${followUp.on}T05:00:00Z`).getTime() : undefined,
    ].filter((at): at is number => at !== undefined)
    out.push({
      item: {
        id: row.id,
        clinicName: row.clinicName,
        firstName: row.firstName,
        lastName: row.lastName,
        product: isClinicalProduct(row.product) ? row.product : "dental",
        stage: waitlistStage(row, found.paid, now),
        reason: toAnswer ? "por_responder" : invitation ? "invitacion" : null,
        answer: answer?.kind === "por_responder" ? answer : null,
        inviteExpiresAt: invitation ? row.inviteExpiresAt : null,
        followUp,
        overdue:
          answer?.kind === "por_responder" && answer.due === "vencida"
            ? true
            : (invitation && row.inviteExpiresAt !== null && row.inviteExpiresAt <= now) || Boolean(followUp?.overdue),
      },
      dueAt: Math.min(...dueAts),
    })
  }
  return out
    .sort((a, b) => Number(b.item.overdue) - Number(a.item.overdue) || a.dueAt - b.dueAt)
    .map(({ item }) => item)
}

/** Descartar pide un motivo y no se le avisa a quien pidió (tablero 6). */
export async function discardWaitlistRequest(tx: Db, actor: AdminActor, id: string, reason: string): Promise<void> {
  const value = reason.trim()
  if (!value) throw invalidField("reason", "Escribe por qué se descarta")
  if (value.length > 500) throw invalidField("reason", "Usa como máximo 500 caracteres")
  const row = await lockRequest(tx, id)
  if (row.status === "entro") throw new ServiceError("WAITLIST_ENTERED", 409, "Esa clínica ya entró: no se puede descartar")
  if (row.claimedAt) throw new ServiceError("WAITLIST_IN_USE", 409, "La invitación se está usando en este momento: intenta en un minuto")
  await tx
    .update(saasWaitlistRequest)
    .set({
      status: "descartada",
      discardReason: value,
      tokenHash: null,
      inviteExpiresAt: null,
      decidedBy: actor.userId,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(saasWaitlistRequest.id, id))
  await writeAdminAudit(tx, actor, { action: "saas.waitlist_discarded", entityId: id })
}

export function invitationTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

export interface FounderInvitationIssued {
  token: string
  expiresAt: Date
  request: WaitlistRow
}

/**
 * Invita (o reenvía con un enlace nuevo, que anula el anterior) con el plan
 * por invitación. Respeta los lugares del plan: una invitación vigente ya
 * ocupa el suyo, y reenviarla no ocupa otro.
 */
export async function inviteFromWaitlist(
  tx: Db,
  actor: AdminActor,
  id: string,
  input: { planId?: string } = {},
  now = new Date(),
): Promise<FounderInvitationIssued> {
  const row = await lockRequest(tx, id)
  if (row.status === "entro") throw new ServiceError("WAITLIST_ENTERED", 409, "Esa clínica ya entró")
  if (row.status === "descartada") throw new ServiceError("WAITLIST_DISCARDED", 409, "Esa solicitud está descartada")
  if (row.claimedAt) throw new ServiceError("WAITLIST_IN_USE", 409, "La invitación se está usando en este momento: intenta en un minuto")
  const requestProduct: ClinicalProduct = isClinicalProduct(row.product) ? row.product : "dental"
  // Sin plan elegido, el de lista de su producto: lo negociado llega con la propuesta (ADR 0093).
  const planId =
    input.planId ??
    row.planId ??
    (await tx.select({ id: saasPlan.id }).from(saasPlan).where(defaultPlanOf(requestProduct)).limit(1))[0]?.id
  if (!planId) {
    throw new ServiceError("SAAS_NO_PLAN", 409, `No hay un plan de ${productWords(requestProduct).name} para invitar: crea uno en Cobros y planes`)
  }
  const [plan] = await tx.select().from(saasPlan).where(eq(saasPlan.id, planId)).limit(1).for("update")
  if (!plan || !plan.isActive) throw notFound("Plan")
  // La clínica entra con un plan de su producto (ADR 0093).
  if (plan.product !== requestProduct) {
    throw validation(`${plan.name} es de ${isClinicalProduct(plan.product) ? productWords(plan.product).name : "otra app"}: esta solicitud es de ${productWords(requestProduct).name}`)
  }
  const token = randomBytes(32).toString("base64url")
  const expiresAt = new Date(now.getTime() + FOUNDER_INVITATION_DAYS * DAY)
  await tx
    .update(saasWaitlistRequest)
    .set({
      status: "invitada",
      planId,
      tokenHash: invitationTokenHash(token),
      inviteExpiresAt: expiresAt,
      invitedAt: now,
      decidedBy: actor.userId,
      decidedAt: now,
      discardReason: null,
      updatedAt: now,
    })
    .where(eq(saasWaitlistRequest.id, id))
  await writeAdminAudit(tx, actor, { action: row.status === "invitada" ? "saas.waitlist_reinvited" : "saas.waitlist_invited", entityId: id, metadata: { planId } })
  const [updated] = await readWaitlistRows(tx, eq(saasWaitlistRequest.id, id), now)
  if (!updated) throw notFound("Solicitud")
  return { token, expiresAt, request: updated }
}

export async function markInvitationSent(tx: Db, id: string): Promise<void> {
  await tx.update(saasWaitlistRequest).set({ invitationSentAt: new Date() }).where(eq(saasWaitlistRequest.id, id))
}

/* ---------- La invitación del lado de quien entra ---------- */

/** Lo que dice el plan por invitación, en cifras: lo leen la web, el correo y el registro. */
export interface FounderOffer {
  planName: string
  currency: string
  priceCents: number
  trialCreditCents: number
  trialDays: number
  /** Descuento sobre el plan de lista en cada acción (redondeado); null si no hay plan de lista para comparar. */
  discountPercent: number | null
  guaranteeMonths: number | null
}

export interface PublicInvitation {
  firstName: string
  lastName: string
  email: string
  clinicName: string
  expiresAt: Date
  offer: FounderOffer
}

/** El porcentaje que una acción cuesta menos que en el plan de lista (el mismo en las tres, o el menor si difieren). */
function discountAgainst(plan: typeof saasPlan.$inferSelect, list: typeof saasPlan.$inferSelect | undefined): number | null {
  if (!list || list.id === plan.id || list.currency !== plan.currency) return null
  const pairs: [number | null, number | null][] = [
    [plan.conversationMicros, list.conversationMicros],
    [plan.consultationMicros, list.consultationMicros],
    [plan.recoveryMicros, list.recoveryMicros],
  ]
  const percents = pairs
    .filter((pair): pair is [number, number] => pair[0] !== null && pair[1] !== null && pair[1] > 0)
    .map(([own, base]) => Math.round((1 - own / base) * 100))
  if (!percents.length) return null
  const lowest = Math.min(...percents)
  return lowest > 0 ? lowest : null
}

export async function founderOffer(tx: Db, plan: typeof saasPlan.$inferSelect): Promise<FounderOffer> {
  // Se compara con el plan de lista de su mismo producto (ADR 0093).
  const product: ClinicalProduct = isClinicalProduct(plan.product) ? plan.product : "dental"
  const [list] = await tx.select().from(saasPlan).where(defaultPlanOf(product)).limit(1)
  return {
    planName: plan.name,
    currency: plan.currency,
    priceCents: plan.priceCents,
    trialCreditCents: plan.trialCreditCents,
    trialDays: plan.trialDays,
    discountPercent: discountAgainst(plan, list),
    guaranteeMonths: plan.guaranteeMonths,
  }
}

/** La invitación vigente detrás de un enlace; null si no existe, venció, se usó o se anuló. */
export async function readFounderInvitation(tx: Db, token: string, now = new Date()): Promise<PublicInvitation | null> {
  if (!token || token.length > 200) return null
  const [found] = await tx
    .select({ row: saasWaitlistRequest, plan: saasPlan })
    .from(saasWaitlistRequest)
    .innerJoin(saasPlan, eq(saasPlan.id, saasWaitlistRequest.planId))
    .where(
      and(
        eq(saasWaitlistRequest.tokenHash, invitationTokenHash(token)),
        eq(saasWaitlistRequest.status, "invitada"),
        gt(saasWaitlistRequest.inviteExpiresAt, now),
      ),
    )
    .limit(1)
  if (!found?.row.inviteExpiresAt) return null
  return {
    firstName: found.row.firstName,
    lastName: found.row.lastName,
    email: found.row.email,
    clinicName: found.row.clinicName,
    expiresAt: found.row.inviteExpiresAt,
    offer: await founderOffer(tx, found.plan),
  }
}

/** Una reserva sin terminar se libera sola pasado este tiempo (la creación se cortó). */
const CLAIM_TTL_MS = 10 * 60 * 1000

/**
 * Reserva la invitación para abrir una clínica: solo la persona del correo
 * invitado, con la invitación vigente y sin otra reserva en curso. Devuelve
 * el id de la solicitud; el guard la libera si la creación falla.
 */
export async function claimFounderInvitation(tx: Db, token: string, userEmail: string, now = new Date()): Promise<string> {
  const [row] = await tx
    .select()
    .from(saasWaitlistRequest)
    .where(eq(saasWaitlistRequest.tokenHash, invitationTokenHash(token)))
    .limit(1)
    .for("update")
  if (!row || row.status !== "invitada" || !row.inviteExpiresAt || row.inviteExpiresAt <= now) {
    throw new ServiceError("INVITATION_INVALID", 403, "Esa invitación ya no sirve: venció, se usó o se anuló. Pide otra respondiendo el correo.")
  }
  if (row.email !== userEmail.trim().toLowerCase()) {
    throw new ServiceError("INVITATION_OTHER_EMAIL", 403, `Esta invitación es para ${row.email}: entra con ese correo para usarla.`)
  }
  if (row.claimedAt && now.getTime() - row.claimedAt.getTime() < CLAIM_TTL_MS) {
    throw new ServiceError("INVITATION_IN_USE", 409, "Ya se está abriendo una clínica con esta invitación")
  }
  await tx.update(saasWaitlistRequest).set({ claimedAt: now, updatedAt: now }).where(eq(saasWaitlistRequest.id, row.id))
  return row.id
}

export async function releaseFounderInvitation(tx: Db, requestId: string): Promise<void> {
  await tx
    .update(saasWaitlistRequest)
    .set({ claimedAt: null, updatedAt: new Date() })
    .where(and(eq(saasWaitlistRequest.id, requestId), eq(saasWaitlistRequest.status, "invitada")))
}

/**
 * La clínica ya se creó con la invitación: queda en el plan de la invitación,
 * con la prueba de ese plan desde ahora y, si el plan las tiene, las
 * condiciones garantizadas por sus meses. La invitación no sirve más. Su
 * cliente del ARM queda con la cuenta y su venta cerrada como «entró».
 */
export async function completeFounderInvitation(tx: Db, requestId: string, orgId: string, now = new Date()): Promise<void> {
  const [row] = await tx.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.id, requestId)).limit(1).for("update")
  if (!row || row.status !== "invitada" || !row.planId) throw new ServiceError("INVITATION_INVALID", 409, "La invitación ya no estaba vigente")
  const [plan] = await tx.select().from(saasPlan).where(eq(saasPlan.id, row.planId)).limit(1)
  if (!plan) throw notFound("Plan")
  // El disparador de la base dejó la suscripción con la prueba del plan por defecto; aquí toma la del plan invitado.
  await enterInvitationPlan(tx, orgId, plan, now)
  await tx
    .update(saasWaitlistRequest)
    .set({ status: "entro", organizationId: orgId, enteredAt: now, claimedAt: null, tokenHash: null, updatedAt: now })
    .where(eq(saasWaitlistRequest.id, requestId))
  // Si su cliente ya tiene otra cuenta (una segunda clínica de la misma persona), la nueva es
  // otro cliente: ligarla a esa ficha se rechazaría y desharía la entrada entera.
  const [requested] = row.clientId
    ? await tx.select({ organizationId: saasClient.organizationId }).from(saasClient).where(eq(saasClient.id, row.clientId)).limit(1)
    : []
  const sameClient = requested?.organizationId && requested.organizationId !== orgId ? null : row.clientId
  const clientId = await linkClientToOrganization(tx, null, { clientId: sameClient, organizationId: orgId, origin: "web", now })
  if (clientId && clientId !== row.clientId) {
    await tx.update(saasWaitlistRequest).set({ clientId }).where(eq(saasWaitlistRequest.id, requestId))
  }
  // Si se invitó con una propuesta aceptada (`inviteClient`), sus condiciones quedan puestas al
  // entrar, con las mismas operaciones de «Precio y prueba». Si no se pueden aplicar (la cuenta
  // quedó en otro plan), la clínica entra igual: queda la constancia para que Administración las
  // ponga a mano, en un punto de guardado para no dejar nada a medias.
  try {
    await tx.transaction((inner) => applyInvitedProposal(inner as Db, requestId, orgId, now))
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error
    await writeAdminAudit(tx, null, {
      action: "arm.proposal_not_applied",
      organizationId: orgId,
      entityId: requestId,
      metadata: { code: error.code },
    })
  }
  await writeAdminAudit(tx, null, { action: "saas.waitlist_entered", organizationId: orgId, entityId: requestId, metadata: { planId: plan.id } })
}

/**
 * La suscripción entra al plan por invitación como al usar la invitación: su prueba desde
 * ahora (la del plan) y, si el plan los tiene, sus meses garantizados.
 */
async function enterInvitationPlan(
  tx: Db,
  orgId: string,
  plan: typeof saasPlan.$inferSelect,
  now: Date,
): Promise<{ trialEndsAt: Date; guaranteedUntil: Date | null }> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`saas:${orgId}`}, 0))`)
  const trialEndsAt = new Date(now.getTime() + plan.trialDays * DAY)
  const guaranteedUntil = plan.guaranteeMonths ? addMonths(now, plan.guaranteeMonths) : null
  const updated = await tx
    .update(saasSubscription)
    .set({
      planId: plan.id,
      status: "prueba",
      trialStartedAt: now,
      trialEndsAt,
      currentPeriodStart: now,
      currentPeriodEnd: trialEndsAt,
      trialCreditCents: null,
      trialDays: null,
      guaranteedUntil,
      updatedAt: now,
    })
    .where(eq(saasSubscription.organizationId, orgId))
    .returning({ id: saasSubscription.organizationId })
  if (!updated.length) throw notFound("Suscripción")
  return { trialEndsAt, guaranteedUntil }
}

/* ---------- Una clínica en prueba pasa a un plan especial ---------- */

/**
 * Un plan especial: activo, de su producto, que no sale en la web ni es el de lista. Lo
 * asigna solo la administración, por lo que negoció (el de Fundadores, por ejemplo).
 */
function specialPlansOf(product: ClinicalProduct): SQL | undefined {
  return and(
    eq(saasPlan.isActive, true),
    eq(saasPlan.product, product),
    eq(saasPlan.showOnWeb, false),
    eq(saasPlan.isDefault, false),
  )
}

export interface SpecialPlanOption {
  id: string
  name: string
  currency: string
  priceCents: number
  guaranteeMonths: number | null
  /** Hasta cuándo valdrían sus precios si pasa ahora; después, el plan de lista. */
  guaranteedUntil: Date | null
  /** Su prueba empieza de nuevo, como al entrar con la invitación. */
  trialDays: number
  trialCreditCents: number
}

/** Lo que ve la administración para «Cambiar a un plan especial» en Plan y pagos. */
export interface SpecialPlanMove {
  plans: SpecialPlanOption[]
  listPlanName: string | null
}

/**
 * Si esta clínica puede pasar a un plan especial: una en prueba, que no es una demo y que
 * nunca tuvo condiciones garantizadas (ni entró con ellas ni se la pasó antes, aunque ya
 * terminaran). A una clínica que ya paga se le negocia con el descuento por clínica.
 */
async function specialPlanRefusal(tx: Db, orgId: string): Promise<ServiceError | null> {
  const [sub] = await tx
    .select({
      status: saasSubscription.status,
      isDemo: saasSubscription.isDemo,
      planId: saasSubscription.planId,
      guaranteedUntil: saasSubscription.guaranteedUntil,
    })
    .from(saasSubscription)
    .where(eq(saasSubscription.organizationId, orgId))
    .limit(1)
  if (!sub) return notFound("Suscripción")
  if (sub.isDemo) return new ServiceError("SPECIAL_PLAN_DEMO", 409, "Una demo no pasa a un plan especial")
  if (sub.status !== "prueba")
    return new ServiceError(
      "SPECIAL_PLAN_NOT_IN_TRIAL",
      409,
      "Solo pasa a un plan especial una clínica en prueba: a una que ya paga, negocia con un descuento",
    )
  const [current] = sub.planId
    ? await tx.select({ guaranteeMonths: saasPlan.guaranteeMonths }).from(saasPlan).where(eq(saasPlan.id, sub.planId)).limit(1)
    : []
  const [entered] = await tx
    .select({ id: saasWaitlistRequest.id })
    .from(saasWaitlistRequest)
    .innerJoin(saasPlan, eq(saasPlan.id, saasWaitlistRequest.planId))
    .where(and(eq(saasWaitlistRequest.organizationId, orgId), eq(saasWaitlistRequest.status, "entro"), isNotNull(saasPlan.guaranteeMonths)))
    .limit(1)
  const [moved] = await tx
    .select({ id: adminAudit.id })
    .from(adminAudit)
    .where(and(eq(adminAudit.organizationId, orgId), eq(adminAudit.action, FOUNDERS_ENTERED_ACTION)))
    .limit(1)
  if (sub.guaranteedUntil || (current && current.guaranteeMonths !== null) || entered || moved)
    return new ServiceError("SPECIAL_PLAN_ALREADY", 409, "Esta clínica ya tiene o tuvo condiciones garantizadas")
  return null
}

/** Lo de «Cambiar a un plan especial»; null si esta clínica no puede o no hay planes especiales. */
export async function getSpecialPlanMove(tx: Db, orgId: string, now = new Date()): Promise<SpecialPlanMove | null> {
  if (await specialPlanRefusal(tx, orgId)) return null
  const product = await orgProduct(tx, orgId)
  const plans = await tx.select().from(saasPlan).where(specialPlansOf(product)).orderBy(asc(saasPlan.sortOrder), asc(saasPlan.createdAt))
  if (!plans.length) return null
  const [list] = await tx.select({ name: saasPlan.name }).from(saasPlan).where(defaultPlanOf(product)).limit(1)
  return {
    plans: plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      currency: plan.currency,
      priceCents: plan.priceCents,
      guaranteeMonths: plan.guaranteeMonths,
      guaranteedUntil: plan.guaranteeMonths ? addMonths(now, plan.guaranteeMonths) : null,
      trialDays: plan.trialDays,
      trialCreditCents: plan.trialCreditCents,
    })),
    listPlanName: list?.name ?? null,
  }
}

export interface SpecialPlanEntered {
  planName: string
  trialEndsAt: Date
  guaranteedUntil: Date | null
}

/**
 * Pasa a un plan especial una clínica que sigue en prueba: queda como si hubiera entrado
 * hoy con la invitación de ese plan —su prueba desde ahora y sus meses garantizados—. Un
 * descuento negociado en el plan de lista se quita: el plan especial trae sus precios y,
 * al terminar sus meses, vuelve al precio de lista. El presupuesto del mes queda como
 * estaba. Solo Administración.
 */
export async function moveClinicToSpecialPlan(
  tx: Db,
  actor: AdminActor,
  orgId: string,
  planId: unknown,
  now = new Date(),
): Promise<SpecialPlanEntered> {
  if (actor.role !== "admin") throw new ServiceError("FORBIDDEN", 403, "Solo Administración cambia una clínica a un plan especial")
  if (typeof planId !== "string" || !UUID.test(planId)) throw invalidField("planId", "Elige el plan")
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`saas:${orgId}`}, 0))`)
  const refusal = await specialPlanRefusal(tx, orgId)
  if (refusal) throw refusal
  const [plan] = await tx
    .select()
    .from(saasPlan)
    .where(and(eq(saasPlan.id, planId), specialPlansOf(await orgProduct(tx, orgId))))
    .limit(1)
  if (!plan) throw invalidField("planId", "Ese plan no es un plan especial de esta app")
  const [before] = await tx
    .select({ discountBps: saasSubscription.discountBps })
    .from(saasSubscription)
    .where(eq(saasSubscription.organizationId, orgId))
    .limit(1)
  const entered = await enterInvitationPlan(tx, orgId, plan, now)
  if (before?.discountBps) {
    await tx
      .update(saasSubscription)
      .set({ discountBps: 0, discountEndsAt: null, updatedAt: now })
      .where(eq(saasSubscription.organizationId, orgId))
  }
  await writeAdminAudit(tx, actor, {
    action: FOUNDERS_ENTERED_ACTION,
    organizationId: orgId,
    metadata: { planId: plan.id, ...(before?.discountBps ? { discountBps: before.discountBps } : {}) },
  })
  // La clínica abierta ve su plan nuevo sin recargar (Plan y pagos y la franja de avisos).
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify({ orgId, kind: "saas.subscription.updated", at: now.toISOString() })})`)
  return { planName: plan.name, ...entered }
}

function addMonths(date: Date, months: number): Date {
  const out = new Date(date.getTime())
  const day = out.getUTCDate()
  out.setUTCDate(1)
  out.setUTCMonth(out.getUTCMonth() + months)
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate()
  out.setUTCDate(Math.min(day, last))
  return out
}

/* ---------- Condiciones garantizadas que terminan ---------- */

/**
 * Quien entró con condiciones garantizadas pasa al plan de lista al día
 * siguiente de su último día (decisión 4). Lo ya contado no cambia: las
 * acciones congelan su precio al contarse. Devuelve las clínicas movidas.
 */
export async function endFounderGuarantees(tx: Db, now = new Date()): Promise<string[]> {
  // Cada clínica pasa al plan de lista de su producto (ADR 0093).
  const lists = new Map<ClinicalProduct, string | null>()
  const listOf = async (product: ClinicalProduct) => {
    if (!lists.has(product)) {
      const [plan] = await tx.select({ id: saasPlan.id }).from(saasPlan).where(defaultPlanOf(product)).limit(1)
      lists.set(product, plan?.id ?? null)
    }
    return lists.get(product) ?? null
  }
  const due = await tx
    .select({ organizationId: saasSubscription.organizationId, planId: saasSubscription.planId })
    .from(saasSubscription)
    .where(lte(saasSubscription.guaranteedUntil, now))
    .for("update")
  const moved: string[] = []
  for (const sub of due) {
    const list = await listOf(await orgProduct(tx, sub.organizationId))
    if (!list) continue
    await tx
      .update(saasSubscription)
      .set({ planId: list, guaranteedUntil: null, updatedAt: now })
      .where(eq(saasSubscription.organizationId, sub.organizationId))
    await writeAdminAudit(tx, null, {
      action: "saas.guarantee_ended",
      organizationId: sub.organizationId,
      metadata: { fromPlanId: sub.planId, toPlanId: list },
    })
    moved.push(sub.organizationId)
  }
  return moved
}

/**
 * Un descuento vencido deja de regir solo al contar (`activeDiscountBps`); el
 * ciclo lo limpia para que la ficha y la lista no lo sigan mostrando, y deja
 * la auditoría de qué venció.
 */
export async function clearExpiredDiscounts(tx: Db, now = new Date()): Promise<number> {
  const rows = await tx
    .update(saasSubscription)
    .set({ discountBps: 0, discountEndsAt: null, updatedAt: now })
    .where(and(lte(saasSubscription.discountEndsAt, now), gt(saasSubscription.discountBps, 0)))
    .returning({ organizationId: saasSubscription.organizationId })
  for (const row of rows) {
    await writeAdminAudit(tx, null, { action: "saas.discount_expired", organizationId: row.organizationId })
  }
  return rows.length
}

/* ---------- Lo que vence pronto, para Inicio de la administración ---------- */

export interface ExpiringTermRow {
  organizationId: string
  organizationName: string
  kind: "precio_especial" | "condiciones"
  endsAt: Date
  discountBps: number | null
}

export async function listExpiringTerms(tx: Db, now = new Date()): Promise<ExpiringTermRow[]> {
  // Desde cuántos días antes se avisa: las condiciones comerciales que rigen (ADR 0074).
  const terms = await currentSaasTerms(tx, now)
  const discountHorizon = new Date(now.getTime() + terms.discountNoticeDays * DAY)
  const guaranteeHorizon = new Date(now.getTime() + terms.guaranteeNoticeDays * DAY)
  const rows = await tx
    .select({
      organizationId: saasSubscription.organizationId,
      organizationName: organization.name,
      discountBps: saasSubscription.discountBps,
      discountEndsAt: saasSubscription.discountEndsAt,
      guaranteedUntil: saasSubscription.guaranteedUntil,
    })
    .from(saasSubscription)
    .innerJoin(organization, eq(organization.id, saasSubscription.organizationId))
    .where(
      or(
        and(gt(saasSubscription.discountBps, 0), gt(saasSubscription.discountEndsAt, now), lte(saasSubscription.discountEndsAt, discountHorizon)),
        and(gt(saasSubscription.guaranteedUntil, now), lte(saasSubscription.guaranteedUntil, guaranteeHorizon)),
      ),
    )
  const out: ExpiringTermRow[] = []
  for (const row of rows) {
    if (row.discountEndsAt && row.discountBps > 0 && row.discountEndsAt > now && row.discountEndsAt <= discountHorizon) {
      out.push({ organizationId: row.organizationId, organizationName: row.organizationName, kind: "precio_especial", endsAt: row.discountEndsAt, discountBps: row.discountBps })
    }
    if (row.guaranteedUntil && row.guaranteedUntil > now && row.guaranteedUntil <= guaranteeHorizon) {
      out.push({ organizationId: row.organizationId, organizationName: row.organizationName, kind: "condiciones", endsAt: row.guaranteedUntil, discountBps: null })
    }
  }
  return out.sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime())
}

/**
 * El número de «Lista de espera» en el menú: las filas de «Prospectos por
 * responder» de Inicio (`waitlistHomeRows` con `reason`), es decir, las que
 * nadie respondió y las invitaciones que vencen en 3 días o ya vencieron. Los
 * seguimientos de hoy no suman: van en su propia sección.
 */
export async function countWaitlistToReview(tx: Db, now = new Date()): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(saasWaitlistRequest)
    .where(or(toAnswerSql, invitationSoonSql(now)))
  return row?.n ?? 0
}

/* ---------- Precios públicos para la web ---------- */

export interface PublicPlanPrices {
  code: string
  name: string
  currency: string
  priceCents: number
  creditCents: number
  /** Gestiona y Completa; los demás tipos, abajo (ADR 0085). */
  conversationMicros: number | null
  consultationMicros: number | null
  recoveryMicros: number | null
  /** Los precios por tipo: sin precio propio, el de su acción (como cobra el plan). */
  tiers: {
    informa: number | null
    gestiona: number | null
    agenda: number | null
    simple: number | null
    estandar: number | null
    completa: number | null
  }
  argosIncludedQuestions: number
  argosPackQuestions: number
  argosPackMicros: number | null
  storageIncludedGb: number
  storageGbMicros: number | null
  trialCreditCents: number
  trialDays: number
}

export interface PublicPricing {
  /** El plan de lista (el por defecto), si se muestra en la web. */
  list: PublicPlanPrices | null
  /** Las condiciones comerciales que la web promete (ADR 0074): la web no las escribe a mano. */
  terms: PublicSaasTerms
}

export interface PublicSaasTerms {
  conversationWindowHours: number
  recoveryWindowDays: number
  reviewAutoPercent: number
  reviewAnswerDays: number
  halfCycleDays: number
  graceDays: number
  /** Prueba cuando no hay un plan por defecto. */
  trialDays: number
  /** Días antes del fin de los meses garantizados de un plan especial en que se le avisa. */
  guaranteeNoticeDays: number
}

function publicPlan(plan: typeof saasPlan.$inferSelect): PublicPlanPrices {
  const prices = planPrices(plan)
  return {
    code: plan.code,
    name: plan.name,
    currency: plan.currency,
    priceCents: plan.priceCents,
    creditCents: plan.creditCents,
    conversationMicros: plan.conversationMicros,
    consultationMicros: plan.consultationMicros,
    recoveryMicros: plan.recoveryMicros,
    tiers: {
      informa: prices.informa,
      gestiona: prices.gestiona,
      agenda: prices.agenda,
      simple: prices.simple,
      estandar: prices.estandar,
      completa: prices.completa,
    },
    argosIncludedQuestions: plan.argosIncludedQuestions,
    argosPackQuestions: plan.argosPackQuestions,
    argosPackMicros: plan.argosPackMicros,
    storageIncludedGb: plan.storageIncludedGb,
    storageGbMicros: plan.storageGbMicros,
    trialCreditCents: plan.trialCreditCents,
    trialDays: plan.trialDays,
  }
}

/**
 * Lo que la web de un producto publica (decisión 14, ADR 0093): solo sus
 * planes activos con «Mostrar en la web». Nunca los lugares que quedan
 * (decisión 9) ni planes de una sola clínica.
 */
export async function getPublicPricing(tx: Db, product: ClinicalProduct = "dental"): Promise<PublicPricing> {
  const plans = await tx
    .select()
    .from(saasPlan)
    .where(and(eq(saasPlan.isActive, true), eq(saasPlan.showOnWeb, true), eq(saasPlan.product, product)))
    .orderBy(asc(saasPlan.sortOrder), asc(saasPlan.createdAt))
  const list = plans.find((plan) => plan.isDefault) ?? null
  return {
    list: list ? publicPlan(list) : null,
    terms: await publicSaasTerms(tx),
  }
}

async function publicSaasTerms(tx: Db): Promise<PublicSaasTerms> {
  const terms = await currentSaasTerms(tx)
  return {
    conversationWindowHours: terms.conversationWindowHours,
    recoveryWindowDays: terms.recoveryWindowDays,
    reviewAutoPercent: terms.reviewAutoPercent,
    reviewAnswerDays: terms.reviewAnswerDays,
    halfCycleDays: terms.halfCycleDays,
    graceDays: terms.graceDays,
    trialDays: terms.trialDays,
    guaranteeNoticeDays: terms.guaranteeNoticeDays,
  }
}
