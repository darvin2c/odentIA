import { createHash, randomBytes } from "node:crypto"
import { CLINICAL_PRODUCTS, type ClinicalProduct, isClinicalProduct, productWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import { organization, user } from "@odentia/db/schema/auth"
import {
  SAAS_WAITLIST_PROFESSIONALS,
  SAAS_WAITLIST_STATUSES,
  SAAS_WAITLIST_TOOLS,
  type SaasSignupMode,
  type SaasWaitlistStatus,
  saasFollowUp,
  saasPayment,
  saasPlan,
  saasSignupPolicy,
  saasSubscription,
  saasWaitlistRequest,
} from "@odentia/db/schema/saas-billing"
import { and, asc, desc, eq, gt, ilike, inArray, lte, ne, or, type SQL, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { z } from "zod"
import { planPrices } from "./saas-actions.js"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import { addBusinessDays, currentSaasTerms, loadSaasTermsTimeline, type SaasTermsTimeline, saasTermsAt } from "./saas-commercial-terms.js"
import { invalidField, notFound, ServiceError, validation } from "./errors.js"
import { orgProduct } from "./locale.js"
import { limaDate } from "./peru-business-days.js"
import { defaultPlanOf } from "./saas-plan-product.js"

/**
 * Fundadores (issue 165): mientras dure el programa, se abren clínicas solo con
 * invitación. Quien quiere entrar deja su solicitud en la web (lista de
 * espera), la administración la revisa e invita, y la invitación abre una sola
 * clínica, con el plan de la invitación. Crear la cuenta sigue libre (decisión
 * 1): lo que pide invitación es abrir la clínica, y lo revisa el servidor en
 * `organization/create`.
 *
 * Todo vive en tablas de la plataforma que solo toca `ownerDb`.
 */

const DAY = 86_400_000
/** La invitación vale 14 días (decisión 8); reenviarla da otros 14. */
export const FOUNDER_INVITATION_DAYS = 14

export type { SaasSignupMode, SaasWaitlistStatus }
export { SAAS_WAITLIST_PROFESSIONALS, SAAS_WAITLIST_STATUSES, SAAS_WAITLIST_TOOLS }
export { founderInvitationEmail, moneyText, waitlistReceivedEmail, waitlistTeamNoticeEmail } from "./saas-emails.js"

/* ---------- Cómo se abren clínicas ---------- */

type SignupPolicyRow = { mode: string; medicalMode: string; opticalMode: string }

/**
 * Dónde guarda cada producto cómo se abren sus clínicas (`saas_signup_policy`,
 * una columna por producto; ADR 0093): un producto nuevo trae la suya.
 */
const SIGNUP_MODE_COLUMN: Record<
  ClinicalProduct,
  { read: (row: SignupPolicyRow) => string; write: (mode: SaasSignupMode) => Partial<SignupPolicyRow> }
> = {
  dental: { read: (row) => row.mode, write: (mode) => ({ mode }) },
  medical: { read: (row) => row.medicalMode, write: (mode) => ({ medicalMode: mode }) },
  optical: { read: (row) => row.opticalMode, write: (mode) => ({ opticalMode: mode }) },
}

/**
 * Cómo se abren las clínicas de un producto (ADR 0093). «Solo con invitación»
 * si no hay fila: lo seguro mientras no se diga otra cosa.
 */
export async function getSignupMode(tx: Db, product: ClinicalProduct = "dental"): Promise<SaasSignupMode> {
  const [row] = await tx
    .select({
      mode: saasSignupPolicy.mode,
      medicalMode: saasSignupPolicy.medicalMode,
      opticalMode: saasSignupPolicy.opticalMode,
    })
    .from(saasSignupPolicy)
    .where(eq(saasSignupPolicy.id, 1))
    .limit(1)
  const mode = row ? SIGNUP_MODE_COLUMN[product].read(row) : undefined
  return mode === "abierta" ? "abierta" : "invitacion"
}

/** Cómo se abren las clínicas de cada producto, para la administración. */
export async function getSignupModes(tx: Db): Promise<Record<ClinicalProduct, SaasSignupMode>> {
  const modes: Partial<Record<ClinicalProduct, SaasSignupMode>> = {}
  // Una tras otra: comparten la transacción.
  for (const product of CLINICAL_PRODUCTS) modes[product] = await getSignupMode(tx, product)
  return modes as Record<ClinicalProduct, SaasSignupMode>
}

export async function setSignupMode(
  tx: Db,
  actor: AdminActor,
  mode: SaasSignupMode,
  product: ClinicalProduct = "dental",
): Promise<SaasSignupMode> {
  if (actor.role !== "admin") throw new ServiceError("FORBIDDEN", 403, "Solo el rol Administración cambia cómo se abren clínicas")
  if (mode !== "invitacion" && mode !== "abierta") throw validation("Elige «Solo con invitación» o «Abierta»")
  const column = SIGNUP_MODE_COLUMN[product].write(mode)
  await tx
    .insert(saasSignupPolicy)
    .values({ id: 1, ...column, updatedBy: actor.userId })
    .onConflictDoUpdate({ target: saasSignupPolicy.id, set: { ...column, updatedBy: actor.userId, updatedAt: new Date() } })
  await writeAdminAudit(tx, actor, { action: "saas.signup_mode_set", metadata: { mode, product } })
  return mode
}

/* ---------- Solicitudes de la web ---------- */

const text = (min: number, max: number, what: string) =>
  z
    .string({ error: `Escribe ${what}` })
    .trim()
    .min(min, `Escribe ${what}`)
    .max(max, `Usa como máximo ${max} caracteres`)

export const waitlistInputSchema = z.strictObject({
  firstName: text(1, 80, "tu nombre"),
  lastName: text(1, 80, "tus apellidos"),
  email: z
    .string({ error: "Escribe tu correo" })
    .trim()
    .toLowerCase()
    .pipe(z.email("Escribe un correo válido, como nombre@clinica.com")),
  /** Con el código del país, como lo muestra el formulario: «+51 987 654 321». */
  phone: z
    .string({ error: "Escribe tu celular" })
    .trim()
    .regex(/^\+?[0-9][0-9 ()-]{5,19}$/, "Escribe un celular válido, solo con números")
    .transform((value) => value.replace(/[ ()-]/g, "")),
  clinicName: text(1, 120, "el nombre de la clínica"),
  countryCode: z
    .string({ error: "Elige el país" })
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Elige el país"),
  city: text(1, 80, "la ciudad"),
  professionals: z.enum(SAAS_WAITLIST_PROFESSIONALS, "Elige cuántos odontólogos atienden"),
  currentTool: z.enum(SAAS_WAITLIST_TOOLS, "Elige qué usan hoy"),
})
export type WaitlistInput = z.input<typeof waitlistInputSchema>

/**
 * La solicitud de un producto: pregunta por quien atiende con su palabra
 * («cuántos médicos» en latidIA; decisión 17 del issue 229).
 */
export function waitlistInputSchemaFor(product: ClinicalProduct) {
  return waitlistInputSchema.extend({
    professionals: z.enum(SAAS_WAITLIST_PROFESSIONALS, `Elige cuántos ${productWords(product).clinician.many} atienden`),
  })
}

export interface WaitlistSubmitResult {
  id: string
  /** Ya había una solicitud viva con ese correo: no se duplica ni se vuelve a escribir. */
  existing: boolean
  /** Días hábiles que se prometen para responderla: los que regían cuando llegó. */
  answerDays: number
}

/**
 * Deja la solicitud en la lista, con el producto del dominio donde se pidió.
 * Un mismo correo con una solicitud viva (por revisar o invitada) no crea
 * otra: se devuelve la que hay.
 */
export async function submitWaitlistRequest(
  tx: Db,
  input: WaitlistInput,
  product: ClinicalProduct = "dental",
): Promise<WaitlistSubmitResult> {
  const parsed = waitlistInputSchemaFor(product).safeParse(input)
  if (!parsed.success) throw validation(parsed.error.issues[0]?.message ?? "Revisa los datos de la solicitud")
  const data = parsed.data
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`waitlist:${data.email}`}, 0))`)
  const [alive] = await tx
    .select({ id: saasWaitlistRequest.id, createdAt: saasWaitlistRequest.createdAt })
    .from(saasWaitlistRequest)
    .where(and(eq(saasWaitlistRequest.email, data.email), inArray(saasWaitlistRequest.status, ["por_revisar", "invitada"])))
    .limit(1)
  if (alive) return { id: alive.id, existing: true, answerDays: (await saasTermsAt(tx, alive.createdAt)).waitlistAnswerDays }
  const [row] = await tx
    .insert(saasWaitlistRequest)
    .values({ ...data, product })
    .returning({ id: saasWaitlistRequest.id, createdAt: saasWaitlistRequest.createdAt })
  if (!row) throw new ServiceError("INTERNAL", 409, "No se pudo guardar la solicitud")
  return { id: row.id, existing: false, answerDays: (await saasTermsAt(tx, row.createdAt)).waitlistAnswerDays }
}

export async function markWaitlistConfirmationSent(tx: Db, id: string): Promise<void> {
  await tx.update(saasWaitlistRequest).set({ confirmationSentAt: new Date() }).where(eq(saasWaitlistRequest.id, id))
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

export interface WaitlistFilter {
  stage?: WaitlistStage | "todas"
  search?: string
}

export interface WaitlistPage {
  rows: WaitlistRow[]
  /** Cuántas hay en cada etapa, entre todas las solicitudes; suman «todas». */
  counts: Record<WaitlistStage | "todas", number>
  /** Lugares del plan por invitación de cada producto, el que se usa al invitar (ADR 0093). */
  seats: Record<ClinicalProduct, FounderSeats | null>
  /** Cómo se abren las clínicas de cada producto. */
  modes: Record<ClinicalProduct, SaasSignupMode>
  /** Días hábiles que se prometen hoy para responder una solicitud. */
  answerDays: number
  /** Hoy, en America/Lima: con él se lee si un «Volver a contactar» ya toca. */
  today: string
}

export interface FounderSeats {
  planId: string
  planName: string
  used: number
  limit: number | null
}

/** Lugares usados de un plan por invitación: las clínicas que entraron y las invitaciones vigentes. */
export async function founderSeats(tx: Db, planId: string, now = new Date()): Promise<FounderSeats> {
  const [plan] = await tx.select({ id: saasPlan.id, name: saasPlan.name, seatLimit: saasPlan.seatLimit }).from(saasPlan).where(eq(saasPlan.id, planId)).limit(1)
  if (!plan) throw notFound("Plan")
  const [row] = await tx
    .select({ used: sql<number>`count(*)::int` })
    .from(saasWaitlistRequest)
    .where(
      and(
        eq(saasWaitlistRequest.planId, planId),
        or(
          eq(saasWaitlistRequest.status, "entro"),
          and(eq(saasWaitlistRequest.status, "invitada"), gt(saasWaitlistRequest.inviteExpiresAt, now)),
        ),
      ),
    )
  return { planId: plan.id, planName: plan.name, used: row?.used ?? 0, limit: plan.seatLimit }
}

/** El plan por invitación de un producto: el activo con lugares, o null si no hay (ADR 0093). */
export async function invitationPlan(tx: Db, product: ClinicalProduct = "dental"): Promise<{ id: string; name: string } | null> {
  const [plan] = await tx
    .select({ id: saasPlan.id, name: saasPlan.name })
    .from(saasPlan)
    .where(and(eq(saasPlan.isActive, true), eq(saasPlan.product, product), sql`${saasPlan.seatLimit} IS NOT NULL`))
    .orderBy(asc(saasPlan.sortOrder), asc(saasPlan.createdAt))
    .limit(1)
  return plan ?? null
}

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

export async function listWaitlist(tx: Db, filter: WaitlistFilter = {}, now = new Date()): Promise<WaitlistPage> {
  const stage = filter.stage ?? "por_revisar"
  const where: SQL[] = []
  if (stage !== "todas") where.push(sql`${stageSql(now)} = ${stage}`)
  const search = filter.search?.trim()
  if (search) {
    const like = `%${search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`
    const matches = or(
      ilike(saasWaitlistRequest.clinicName, like),
      ilike(saasWaitlistRequest.email, like),
      ilike(sql`${saasWaitlistRequest.firstName} || ' ' || ${saasWaitlistRequest.lastName}`, like),
    )
    if (matches) where.push(matches)
  }
  const rows = await readWaitlistRows(tx, where.length ? and(...where) : undefined, now, {
    // Por revisar: primero las que vencen antes (las más viejas). Lo demás: lo último primero.
    orderBy: [stage === "por_revisar" ? asc(saasWaitlistRequest.createdAt) : desc(saasWaitlistRequest.updatedAt)],
    limit: 200,
  })
  // Los conteos, entre todas las solicitudes y con la etapa calculada en la base: suman «todas».
  const countRows = await tx
    .select({ stage: stageSql(now), n: sql<number>`count(*)::int` })
    .from(saasWaitlistRequest)
    .groupBy(sql`1`)
  const counts = Object.fromEntries([...WAITLIST_STAGES, "todas"].map((s) => [s, 0])) as Record<WaitlistStage | "todas", number>
  for (const entry of countRows) {
    counts[entry.stage] = entry.n
    counts.todas += entry.n
  }
  const timeline = await loadSaasTermsTimeline(tx)
  const seatsOf = async (product: ClinicalProduct) => {
    const plan = await invitationPlan(tx, product)
    return plan ? await founderSeats(tx, plan.id, now) : null
  }
  const seats: Partial<Record<ClinicalProduct, FounderSeats | null>> = {}
  for (const product of CLINICAL_PRODUCTS) seats[product] = await seatsOf(product)
  return {
    rows,
    counts,
    seats: seats as Record<ClinicalProduct, FounderSeats | null>,
    modes: await getSignupModes(tx),
    answerDays: timeline.at(now).waitlistAnswerDays,
    today: limaDate(now),
  }
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
  /** Los lugares del plan por invitación de su producto, el que se usa al invitar. */
  seats: FounderSeats | null
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
  const plan = await invitationPlan(tx, request.product)
  return {
    request,
    entries: entries.map((entry) => ({ ...entry, body: entry.adminOnly && actor.role !== "admin" ? null : entry.body })),
    seats: plan ? await founderSeats(tx, plan.id, now) : null,
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

/**
 * La ruta vieja de la nota (`PUT /:id/note`), que sigue usando una pestaña
 * abierta antes de este despliegue. Ya no escribe `note`: agrega una entrada
 * con el texto y le copia la fecha pendiente, para no cerrar el recordatorio.
 * Es una nota, como la de antes (`fromNote`): no cuenta como haberle
 * respondido. Sin texto, o con el mismo texto de la última entrada, no hace
 * nada. Se borra
 * en la entrega siguiente, junto con la columna.
 */
export async function setWaitlistNote(tx: Db, actor: AdminActor, id: string, note: string | null, now = new Date()): Promise<void> {
  const value = note?.trim() ? note.trim() : null
  if (value && value.length > 2000) throw invalidField("note", "La nota puede tener como máximo 2000 caracteres")
  if (!value) return
  await lockRequest(tx, id)
  const [last] = await tx
    .select({ body: saasFollowUp.body, followUpOn: saasFollowUp.followUpOn })
    .from(saasFollowUp)
    .where(eq(saasFollowUp.requestId, id))
    .orderBy(desc(saasFollowUp.createdAt), desc(saasFollowUp.id))
    .limit(1)
  if (last?.body === value) return
  await insertFollowUp(tx, actor, id, { body: value, followUpOn: last?.followUpOn ?? null, adminOnly: false, fromNote: true }, now)
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
  const planId = input.planId ?? row.planId ?? (await invitationPlan(tx, requestProduct))?.id
  if (!planId) {
    throw new ServiceError("SAAS_NO_INVITATION_PLAN", 409, `No hay un plan por invitación de ${productWords(requestProduct).name}: crea uno con lugares en Cobros y planes`)
  }
  const [plan] = await tx.select().from(saasPlan).where(eq(saasPlan.id, planId)).limit(1).for("update")
  if (!plan || !plan.isActive) throw notFound("Plan")
  // La clínica entra con un plan de su producto (ADR 0093).
  if (plan.product !== requestProduct) {
    throw validation(`${plan.name} es de ${productWords(plan.product as ClinicalProduct).name}: esta solicitud es de ${productWords(requestProduct).name}`)
  }
  // Reenviar una invitación vigente del mismo plan no ocupa otro lugar.
  const holdsSeat = row.status === "invitada" && row.planId === planId && row.inviteExpiresAt !== null && row.inviteExpiresAt > now
  if (plan.seatLimit !== null && !holdsSeat) {
    const seats = await founderSeats(tx, planId, now)
    if (seats.used >= plan.seatLimit) {
      throw new ServiceError("SAAS_SEATS_FULL", 409, `Los ${plan.seatLimit} lugares de ${plan.name} están ocupados: sube los lugares del plan para invitar`)
    }
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
 * condiciones garantizadas por sus meses. La invitación no sirve más.
 */
export async function completeFounderInvitation(tx: Db, requestId: string, orgId: string, now = new Date()): Promise<void> {
  const [row] = await tx.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.id, requestId)).limit(1).for("update")
  if (!row || row.status !== "invitada" || !row.planId) throw new ServiceError("INVITATION_INVALID", 409, "La invitación ya no estaba vigente")
  const [plan] = await tx.select().from(saasPlan).where(eq(saasPlan.id, row.planId)).limit(1)
  if (!plan) throw notFound("Plan")
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`saas:${orgId}`}, 0))`)
  const trialEnds = new Date(now.getTime() + plan.trialDays * DAY)
  const guaranteedUntil = plan.guaranteeMonths ? addMonths(now, plan.guaranteeMonths) : null
  // El disparador de la base dejó la suscripción con la prueba del plan por defecto; aquí toma la del plan invitado.
  const updated = await tx
    .update(saasSubscription)
    .set({
      planId: plan.id,
      status: "prueba",
      trialStartedAt: now,
      trialEndsAt: trialEnds,
      currentPeriodStart: now,
      currentPeriodEnd: trialEnds,
      trialCreditCents: null,
      trialDays: null,
      guaranteedUntil,
      updatedAt: now,
    })
    .where(eq(saasSubscription.organizationId, orgId))
    .returning({ id: saasSubscription.organizationId })
  if (!updated.length) throw notFound("Suscripción")
  await tx
    .update(saasWaitlistRequest)
    .set({ status: "entro", organizationId: orgId, enteredAt: now, claimedAt: null, tokenHash: null, updatedAt: now })
    .where(eq(saasWaitlistRequest.id, requestId))
  await writeAdminAudit(tx, null, { action: "saas.waitlist_entered", organizationId: orgId, entityId: requestId, metadata: { planId: plan.id } })
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
  /** El plan por invitación (Fundadores), si se muestra en la web. */
  founders: (PublicPlanPrices & { discountPercent: number | null; guaranteeMonths: number | null }) | null
  signupMode: SaasSignupMode
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
  waitlistAnswerDays: number
  /** Días antes del fin de los meses garantizados de una Fundadora en que se le avisa. */
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
  const founders = plans.find((plan) => plan.seatLimit !== null) ?? null
  const [defaultPlan] = list ? [list] : await tx.select().from(saasPlan).where(defaultPlanOf(product)).limit(1)
  return {
    list: list ? publicPlan(list) : null,
    founders: founders
      ? { ...publicPlan(founders), discountPercent: discountAgainst(founders, defaultPlan), guaranteeMonths: founders.guaranteeMonths }
      : null,
    signupMode: await getSignupMode(tx, product),
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
    waitlistAnswerDays: terms.waitlistAnswerDays,
    guaranteeNoticeDays: terms.guaranteeNoticeDays,
  }
}

/** Para el panel: ¿esta persona puede abrir una clínica de este producto sin invitación? */
export async function canOpenClinicWithoutInvitation(tx: Db, product: ClinicalProduct = "dental"): Promise<boolean> {
  return (await getSignupMode(tx, product)) === "abierta"
}
