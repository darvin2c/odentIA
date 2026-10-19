import { createHash, randomBytes } from "node:crypto"
import type { Db } from "@odentia/db"
import { organization, user } from "@odentia/db/schema/auth"
import {
  SAAS_WAITLIST_DENTISTS,
  SAAS_WAITLIST_STATUSES,
  SAAS_WAITLIST_TOOLS,
  type SaasSignupMode,
  type SaasWaitlistStatus,
  saasPlan,
  saasSignupPolicy,
  saasSubscription,
  saasWaitlistRequest,
} from "@odentia/db/schema/saas-billing"
import { and, asc, desc, eq, gt, ilike, inArray, lte, or, sql } from "drizzle-orm"
import { z } from "zod"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import { notFound, ServiceError, validation } from "./errors.js"

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
/** Lo que se promete para responder una solicitud: días hábiles (decisión 7). */
export const WAITLIST_ANSWER_DAYS = 2

export type { SaasSignupMode, SaasWaitlistStatus }
export { SAAS_WAITLIST_DENTISTS, SAAS_WAITLIST_STATUSES, SAAS_WAITLIST_TOOLS }
export { founderInvitationEmail, moneyText, waitlistReceivedEmail } from "./saas-emails.js"

/* ---------- Cómo se abren clínicas ---------- */

/** «Solo con invitación» si no hay fila: lo seguro mientras no se diga otra cosa. */
export async function getSignupMode(tx: Db): Promise<SaasSignupMode> {
  const [row] = await tx.select({ mode: saasSignupPolicy.mode }).from(saasSignupPolicy).where(eq(saasSignupPolicy.id, 1)).limit(1)
  return row?.mode === "abierta" ? "abierta" : "invitacion"
}

export async function setSignupMode(tx: Db, actor: AdminActor, mode: SaasSignupMode): Promise<SaasSignupMode> {
  if (actor.role !== "admin") throw new ServiceError("FORBIDDEN", 403, "Solo la administración de odentIA cambia cómo se abren clínicas")
  if (mode !== "invitacion" && mode !== "abierta") throw validation("Elige «Solo con invitación» o «Abierta»")
  await tx
    .insert(saasSignupPolicy)
    .values({ id: 1, mode, updatedBy: actor.userId })
    .onConflictDoUpdate({ target: saasSignupPolicy.id, set: { mode, updatedBy: actor.userId, updatedAt: new Date() } })
  await writeAdminAudit(tx, actor, { action: "saas.signup_mode_set", metadata: { mode } })
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
  dentists: z.enum(SAAS_WAITLIST_DENTISTS, "Elige cuántos odontólogos atienden"),
  currentTool: z.enum(SAAS_WAITLIST_TOOLS, "Elige qué usan hoy"),
})
export type WaitlistInput = z.input<typeof waitlistInputSchema>

export interface WaitlistSubmitResult {
  id: string
  /** Ya había una solicitud viva con ese correo: no se duplica ni se vuelve a escribir. */
  existing: boolean
}

/**
 * Deja la solicitud en la lista. Un mismo correo con una solicitud viva
 * (por revisar o invitada) no crea otra: se devuelve la que hay.
 */
export async function submitWaitlistRequest(tx: Db, input: WaitlistInput): Promise<WaitlistSubmitResult> {
  const parsed = waitlistInputSchema.safeParse(input)
  if (!parsed.success) throw validation(parsed.error.issues[0]?.message ?? "Revisa los datos de la solicitud")
  const data = parsed.data
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`waitlist:${data.email}`}, 0))`)
  const [alive] = await tx
    .select({ id: saasWaitlistRequest.id })
    .from(saasWaitlistRequest)
    .where(and(eq(saasWaitlistRequest.email, data.email), inArray(saasWaitlistRequest.status, ["por_revisar", "invitada"])))
    .limit(1)
  if (alive) return { id: alive.id, existing: true }
  const [row] = await tx.insert(saasWaitlistRequest).values(data).returning({ id: saasWaitlistRequest.id })
  if (!row) throw new ServiceError("INTERNAL", 409, "No se pudo guardar la solicitud")
  return { id: row.id, existing: false }
}

export async function markWaitlistConfirmationSent(tx: Db, id: string): Promise<void> {
  await tx.update(saasWaitlistRequest).set({ confirmationSentAt: new Date() }).where(eq(saasWaitlistRequest.id, id))
}

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
  dentists: string
  currentTool: string
  status: SaasWaitlistStatus
  note: string | null
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
  /** Por revisar: el último instante para responder (2 días hábiles, de lunes a viernes). */
  answerBy: Date | null
}

/** Suma `days` días hábiles (lunes a viernes) a `from`: el plazo que se promete en la web. */
export function addBusinessDays(from: Date, days: number): Date {
  const out = new Date(from.getTime())
  let left = days
  while (left > 0) {
    out.setUTCDate(out.getUTCDate() + 1)
    const weekday = out.getUTCDay()
    if (weekday !== 0 && weekday !== 6) left -= 1
  }
  return out
}

export interface WaitlistFilter {
  status?: SaasWaitlistStatus | "todas"
  search?: string
}

export interface WaitlistPage {
  rows: WaitlistRow[]
  counts: Record<SaasWaitlistStatus, number>
  /** Lugares del plan por invitación con tope, el que se usa al invitar. */
  seats: FounderSeats | null
  mode: SaasSignupMode
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

/** El plan por invitación que se ofrece al invitar: el activo con lugares, o null si no hay. */
export async function invitationPlan(tx: Db): Promise<{ id: string; name: string } | null> {
  const [plan] = await tx
    .select({ id: saasPlan.id, name: saasPlan.name })
    .from(saasPlan)
    .where(and(eq(saasPlan.isActive, true), sql`${saasPlan.seatLimit} IS NOT NULL`))
    .orderBy(asc(saasPlan.sortOrder), asc(saasPlan.createdAt))
    .limit(1)
  return plan ?? null
}

export async function listWaitlist(tx: Db, filter: WaitlistFilter = {}, now = new Date()): Promise<WaitlistPage> {
  const status = filter.status ?? "por_revisar"
  const where = []
  if (status !== "todas") where.push(eq(saasWaitlistRequest.status, status))
  const search = filter.search?.trim()
  if (search) {
    const like = `%${search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`
    where.push(
      or(
        ilike(saasWaitlistRequest.clinicName, like),
        ilike(saasWaitlistRequest.email, like),
        ilike(sql`${saasWaitlistRequest.firstName} || ' ' || ${saasWaitlistRequest.lastName}`, like),
      ),
    )
  }
  const decider = sql<string | null>`(select ${user.name} from ${user} where ${user.id} = ${saasWaitlistRequest.decidedBy})`
  const rows = await tx
    .select({ row: saasWaitlistRequest, planName: saasPlan.name, organizationName: organization.name, decidedByName: decider })
    .from(saasWaitlistRequest)
    .leftJoin(saasPlan, eq(saasPlan.id, saasWaitlistRequest.planId))
    .leftJoin(organization, eq(organization.id, saasWaitlistRequest.organizationId))
    .where(where.length ? and(...where) : undefined)
    // Por revisar: primero las que vencen antes (las más viejas). Lo demás: lo último primero.
    .orderBy(status === "por_revisar" ? asc(saasWaitlistRequest.createdAt) : desc(saasWaitlistRequest.updatedAt))
    .limit(200)
  const countRows = await tx
    .select({ status: saasWaitlistRequest.status, n: sql<number>`count(*)::int` })
    .from(saasWaitlistRequest)
    .groupBy(saasWaitlistRequest.status)
  const counts = Object.fromEntries(SAAS_WAITLIST_STATUSES.map((s) => [s, 0])) as Record<SaasWaitlistStatus, number>
  for (const entry of countRows) counts[entry.status as SaasWaitlistStatus] = entry.n
  const plan = await invitationPlan(tx)
  return {
    rows: rows.map(({ row, planName, organizationName, decidedByName }) => toWaitlistRow(row, planName, organizationName, decidedByName)),
    counts,
    seats: plan ? await founderSeats(tx, plan.id, now) : null,
    mode: await getSignupMode(tx),
  }
}

function toWaitlistRow(
  row: typeof saasWaitlistRequest.$inferSelect,
  planName: string | null,
  organizationName: string | null,
  decidedByName: string | null,
): WaitlistRow {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    clinicName: row.clinicName,
    countryCode: row.countryCode,
    city: row.city,
    dentists: row.dentists,
    currentTool: row.currentTool,
    status: row.status as SaasWaitlistStatus,
    note: row.note,
    discardReason: row.discardReason,
    planId: row.planId,
    planName,
    inviteExpiresAt: row.inviteExpiresAt,
    invitedAt: row.invitedAt,
    organizationId: row.organizationId,
    organizationName,
    enteredAt: row.enteredAt,
    decidedByName,
    createdAt: row.createdAt,
    answerBy: row.status === "por_revisar" ? addBusinessDays(row.createdAt, WAITLIST_ANSWER_DAYS) : null,
  }
}

async function lockRequest(tx: Db, id: string) {
  const [row] = await tx.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.id, id)).limit(1).for("update")
  if (!row) throw notFound("Solicitud")
  return row
}

export async function setWaitlistNote(tx: Db, actor: AdminActor, id: string, note: string | null): Promise<void> {
  const value = note?.trim() ? note.trim() : null
  if (value && value.length > 2000) throw validation("La nota puede tener como máximo 2000 caracteres")
  await lockRequest(tx, id)
  await tx.update(saasWaitlistRequest).set({ note: value, updatedAt: new Date() }).where(eq(saasWaitlistRequest.id, id))
  await writeAdminAudit(tx, actor, { action: "saas.waitlist_note", entityId: id })
}

/** Descartar pide un motivo y no se le avisa a quien pidió (tablero 6). */
export async function discardWaitlistRequest(tx: Db, actor: AdminActor, id: string, reason: string): Promise<void> {
  const value = reason.trim()
  if (!value) throw validation("Escribe por qué se descarta")
  if (value.length > 500) throw validation("Usa como máximo 500 caracteres")
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
  const planId = input.planId ?? row.planId ?? (await invitationPlan(tx))?.id
  if (!planId) throw new ServiceError("SAAS_NO_INVITATION_PLAN", 409, "No hay un plan por invitación: crea uno con lugares en Cobros y planes")
  const [plan] = await tx.select().from(saasPlan).where(eq(saasPlan.id, planId)).limit(1).for("update")
  if (!plan || !plan.isActive) throw notFound("Plan")
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
  const [updated] = await tx
    .select({ row: saasWaitlistRequest })
    .from(saasWaitlistRequest)
    .where(eq(saasWaitlistRequest.id, id))
    .limit(1)
  if (!updated) throw notFound("Solicitud")
  return { token, expiresAt, request: toWaitlistRow(updated.row, plan.name, null, null) }
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
  const [list] = await tx.select().from(saasPlan).where(and(eq(saasPlan.isDefault, true), eq(saasPlan.isActive, true))).limit(1)
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
  const [list] = await tx.select({ id: saasPlan.id }).from(saasPlan).where(and(eq(saasPlan.isDefault, true), eq(saasPlan.isActive, true))).limit(1)
  if (!list) return []
  const due = await tx
    .select({ organizationId: saasSubscription.organizationId, planId: saasSubscription.planId })
    .from(saasSubscription)
    .where(lte(saasSubscription.guaranteedUntil, now))
    .for("update")
  const moved: string[] = []
  for (const sub of due) {
    await tx
      .update(saasSubscription)
      .set({ planId: list.id, guaranteedUntil: null, updatedAt: now })
      .where(eq(saasSubscription.organizationId, sub.organizationId))
    await writeAdminAudit(tx, null, {
      action: "saas.guarantee_ended",
      organizationId: sub.organizationId,
      metadata: { fromPlanId: sub.planId, toPlanId: list.id },
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
  const discountHorizon = new Date(now.getTime() + 15 * DAY)
  const guaranteeHorizon = new Date(now.getTime() + 30 * DAY)
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

/** Las solicitudes por revisar, para el número del menú y Inicio. */
export async function countWaitlistToReview(tx: Db): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(saasWaitlistRequest)
    .where(eq(saasWaitlistRequest.status, "por_revisar"))
  return row?.n ?? 0
}

/* ---------- Precios públicos para la web ---------- */

export interface PublicPlanPrices {
  code: string
  name: string
  currency: string
  priceCents: number
  creditCents: number
  conversationMicros: number | null
  consultationMicros: number | null
  recoveryMicros: number | null
  trialCreditCents: number
  trialDays: number
}

export interface PublicPricing {
  /** El plan de lista (el por defecto), si se muestra en la web. */
  list: PublicPlanPrices | null
  /** El plan por invitación (Fundadores), si se muestra en la web. */
  founders: (PublicPlanPrices & { discountPercent: number | null; guaranteeMonths: number | null }) | null
  signupMode: SaasSignupMode
}

function publicPlan(plan: typeof saasPlan.$inferSelect): PublicPlanPrices {
  return {
    code: plan.code,
    name: plan.name,
    currency: plan.currency,
    priceCents: plan.priceCents,
    creditCents: plan.creditCents,
    conversationMicros: plan.conversationMicros,
    consultationMicros: plan.consultationMicros,
    recoveryMicros: plan.recoveryMicros,
    trialCreditCents: plan.trialCreditCents,
    trialDays: plan.trialDays,
  }
}

/**
 * Lo que la web publica (decisión 14): solo los planes activos con «Mostrar
 * en la web». Nunca los lugares que quedan (decisión 9) ni planes de una
 * sola clínica.
 */
export async function getPublicPricing(tx: Db): Promise<PublicPricing> {
  const plans = await tx
    .select()
    .from(saasPlan)
    .where(and(eq(saasPlan.isActive, true), eq(saasPlan.showOnWeb, true)))
    .orderBy(asc(saasPlan.sortOrder), asc(saasPlan.createdAt))
  const list = plans.find((plan) => plan.isDefault) ?? null
  const founders = plans.find((plan) => plan.seatLimit !== null) ?? null
  const [defaultPlan] = list ? [list] : await tx.select().from(saasPlan).where(and(eq(saasPlan.isDefault, true), eq(saasPlan.isActive, true))).limit(1)
  return {
    list: list ? publicPlan(list) : null,
    founders: founders
      ? { ...publicPlan(founders), discountPercent: discountAgainst(founders, defaultPlan), guaranteeMonths: founders.guaranteeMonths }
      : null,
    signupMode: await getSignupMode(tx),
  }
}

/** Para el panel: ¿esta persona puede abrir una clínica sin invitación? */
export async function canOpenClinicWithoutInvitation(tx: Db): Promise<boolean> {
  return (await getSignupMode(tx)) === "abierta"
}
