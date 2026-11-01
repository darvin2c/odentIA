/**
 * «Mi calendario» (issue 46, ADR 0082): quien atiende ve sus citas de la
 * clínica en Google, Apple u Outlook con un enlace privado, solo para leer.
 *
 * - Un enlace activo por persona y por clínica. El token no se guarda: se
 *   recalcula con la clave del servidor y el id (como «Su enlace»); la base
 *   guarda su huella para encontrarlo.
 * - De cada cita sale lo mínimo: «Paciente · R. P.», la hora, la sede con su
 *   dirección, la unidad dental y un enlace a la cita que pide entrar. Nunca el
 *   nombre, el servicio ni el motivo, para ninguna clínica.
 * - Citas de hoy a 90 días; las canceladas no salen. El `UID` y el `SEQUENCE`
 *   son los del archivo de la cita (lote 1), así no se duplica.
 * - Cada pedido del calendario suma en una fila por día y programa (sin IP),
 *   que se borra a los 90 días. Un programa nuevo avisa a la persona.
 * - Deja de servir solo si la persona ya no es del equipo o ya no atiende.
 */
import { createHash, createHmac } from "node:crypto"
import { canAttend } from "@odentia/auth/permissions"
import { productWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { appointment, calendarFeed, calendarFeedUse, scheduleRoom } from "@odentia/db/schema/agenda"
import { member } from "@odentia/db/schema/auth"
import { patient } from "@odentia/db/schema/clinical"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, asc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm"
import { zonedTimeToUtc } from "./availability.js"
import { branchAddressColumns, branchAddressWriter } from "./branches.js"
import { clinicDisplayName } from "./clinic-identity.js"
import { notFound, ServiceError } from "./errors.js"
import { calendarFeedFile, type CalendarEvent } from "./icalendar.js"
import { findOrgLocale, orgProduct } from "./locale.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
import { clinicOriginOf } from "./public-links.js"
import { createWorkspaceNotification } from "./workspace.js"

export const CALENDAR_FEED_DAYS_AHEAD = 90
export const CALENDAR_USE_KEEP_DAYS = 90
/** Lo que muestra el panel de quién usa el enlace. */
const RECENT_DAYS = 7
/** Los programas que se suman en el primer día del enlace son de quien lo creó. */
const SETUP_MS = 24 * 3_600_000

export const CALENDAR_CLIENTS = ["google", "iphone", "mac", "outlook", "navegador", "otro"] as const
export type CalendarClient = (typeof CALENDAR_CLIENTS)[number]

export const CALENDAR_CLIENT_LABELS: Record<CalendarClient, string> = {
  google: "Google Calendar",
  iphone: "Calendario del iPhone",
  mac: "Calendario de la Mac",
  outlook: "Outlook",
  navegador: "Navegador web",
  otro: "Otro programa",
}

/**
 * Qué programa pide el calendario, por su `User-Agent`. Se cuenta el programa
 * y no el lugar: Google pide desde muchos servidores distintos y contar
 * direcciones daría avisos falsos.
 */
export function calendarClientOf(userAgent: string | null | undefined): CalendarClient {
  const ua = userAgent ?? ""
  if (/Google-Calendar-Importer|Google-Calendar|GoogleCalendar/i.test(ua)) return "google"
  if (/iPhone|iPad|iOS|dataaccessd/i.test(ua)) return "iphone"
  if (/Macintosh|Mac OS X|CalendarAgent|DAVKit/i.test(ua) && !/Mozilla/i.test(ua)) return "mac"
  if (/Outlook|Microsoft|Exchange|MSOffice/i.test(ua)) return "outlook"
  if (/Mozilla|Chrome|Safari|Firefox|Edg\//i.test(ua)) return "navegador"
  return "otro"
}

/** El token del enlace: no se guarda, se recalcula (como «Su enlace»). */
export function calendarFeedToken(secretsKey: Buffer, feedId: string): string {
  return createHmac("sha256", secretsKey).update(`calendario:${feedId}`).digest("hex")
}

function tokenHashOf(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

const TOKEN_RE = /^[0-9a-f]{64}$/

export interface CalendarFeedDeps {
  secretsKey: Buffer
  /** Origen público de la API, donde vive el archivo del calendario; sin él no hay enlace que dar. */
  feedBaseUrl: string | null
}

export interface CalendarFeedUse {
  client: CalendarClient
  label: string
  /** Primer día en que lo usó, dentro de lo que se guarda (YYYY-MM-DD). */
  since: string
  lastAt: string
  /** Cuántos días de los últimos 7 lo usó. */
  days: number
  /** Programa que la persona no reconoció todavía. */
  isNew: boolean
}

export interface MyCalendarFeed {
  /** Puede tener uno: atiende pacientes en esta clínica. */
  allowed: boolean
  /** Su próxima cita tal como saldrá en su calendario, para mostrarla antes de crear el enlace. */
  preview: { summary: string; start: string; end: string; timeZone: string; location: string | null } | null
  feed: null | {
    createdAt: string
    url: string | null
    webcalUrl: string | null
    googleUrl: string | null
    lastUsedAt: string | null
    clients: CalendarFeedUse[]
    /** El programa nuevo más reciente, si hay uno sin reconocer. */
    alert: { client: CalendarClient; label: string; at: string } | null
  }
}

async function attends(tx: Db, orgId: string, userId: string): Promise<boolean> {
  const rows = await tx
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
  return rows.some((row) => canAttend(row.role))
}

async function requireAttends(tx: Db, orgId: string, userId: string): Promise<void> {
  if (!(await attends(tx, orgId, userId))) {
    throw new ServiceError("FORBIDDEN", 403, "«Mi calendario» es para quien atiende pacientes")
  }
}

async function activeFeed(tx: Db, orgId: string, userId: string) {
  const [row] = await tx
    .select()
    .from(calendarFeed)
    .where(and(eq(calendarFeed.organizationId, orgId), eq(calendarFeed.userId, userId), eq(calendarFeed.status, "activo")))
    .limit(1)
  return row ?? null
}

async function audit(tx: Db, orgId: string, actorUserId: string | null, action: string, feedId: string, metadata: Record<string, unknown> = {}) {
  await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action, entity: "calendar_feed", entityId: feedId, metadata })
}

function feedUrls(deps: CalendarFeedDeps, feedId: string) {
  if (!deps.feedBaseUrl) return { url: null, webcalUrl: null, googleUrl: null }
  const url = `${deps.feedBaseUrl.replace(/\/$/, "")}/api/public/calendar/${calendarFeedToken(deps.secretsKey, feedId)}.ics`
  const webcalUrl = url.replace(/^https?:/, "webcal:")
  // Google se suscribe con la dirección `webcal` en `cid`.
  return { url, webcalUrl, googleUrl: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}` }
}

function isoDay(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString().slice(0, 10)
}

/** El día de hoy en la zona de la clínica (YYYY-MM-DD). */
function todayIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}

function daysBefore(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10)
}

/** Lo que ve quien atiende en «Mi calendario». */
export async function getMyCalendarFeed(tx: Db, orgId: string, userId: string, deps: CalendarFeedDeps, now = new Date()): Promise<MyCalendarFeed> {
  if (!(await attends(tx, orgId, userId))) return { allowed: false, preview: null, feed: null }
  const clinicZone = (await findOrgLocale(tx, orgId)).timezone
  const [next] = await feedEvents(tx, orgId, userId, clinicZone, now, { from: now, limit: 1 })
  const preview = next
    ? { summary: next.summary, start: next.start.toISOString(), end: next.end.toISOString(), timeZone: next.timeZone, location: next.location ?? null }
    : null
  const feed = await activeFeed(tx, orgId, userId)
  if (!feed) return { allowed: true, preview, feed: null }
  const today = todayIn(clinicZone, now)
  const uses = await tx
    .select()
    .from(calendarFeedUse)
    .where(and(eq(calendarFeedUse.organizationId, orgId), eq(calendarFeedUse.feedId, feed.id)))
    .orderBy(asc(calendarFeedUse.day))
  const recentFrom = daysBefore(today, RECENT_DAYS - 1)
  const byClient = new Map<CalendarClient, CalendarFeedUse>()
  for (const use of uses) {
    const client = (CALENDAR_CLIENTS as readonly string[]).includes(use.client) ? (use.client as CalendarClient) : "otro"
    const day = isoDay(use.day)
    const current = byClient.get(client)
    const lastAt = use.lastAt.toISOString()
    byClient.set(client, {
      client,
      label: CALENDAR_CLIENT_LABELS[client],
      since: current?.since ?? day,
      lastAt: current && current.lastAt > lastAt ? current.lastAt : lastAt,
      days: (current?.days ?? 0) + (day >= recentFrom ? 1 : 0),
      isNew: !feed.knownClients.includes(client),
    })
  }
  const clients = [...byClient.values()].filter((item) => item.days > 0).sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))
  const fresh = clients.filter((item) => item.isNew)
  const lastUsedAt = clients[0]?.lastAt ?? null
  return {
    allowed: true,
    preview,
    feed: {
      createdAt: feed.createdAt.toISOString(),
      ...feedUrls(deps, feed.id),
      lastUsedAt,
      clients,
      alert: fresh[0] ? { client: fresh[0].client, label: fresh[0].label, at: fresh[0].lastAt } : null,
    },
  }
}

/** «Crear mi enlace»: si ya tiene uno, es ese. */
export async function createMyCalendarFeed(tx: Db, orgId: string, userId: string, deps: CalendarFeedDeps): Promise<MyCalendarFeed> {
  await requireAttends(tx, orgId, userId)
  if (!(await activeFeed(tx, orgId, userId))) await insertFeed(tx, orgId, userId, deps, "calendar_feed.created")
  return getMyCalendarFeed(tx, orgId, userId, deps)
}

async function insertFeed(tx: Db, orgId: string, userId: string, deps: CalendarFeedDeps, action: string) {
  // El id se elige antes para guardar la huella del token en la misma fila.
  const id = crypto.randomUUID()
  // Un doble clic llega dos veces: el índice de un activo por persona deja pasar
  // uno y el otro no hace nada (devuelve el que quedó).
  const [created] = await tx
    .insert(calendarFeed)
    .values({ id, organizationId: orgId, userId, tokenHash: tokenHashOf(calendarFeedToken(deps.secretsKey, id)) })
    .onConflictDoNothing()
    .returning({ id: calendarFeed.id })
  if (created) await audit(tx, orgId, userId, action, id)
}

async function revoke(tx: Db, orgId: string, feedId: string, by: string | null, reason: "cambiado" | "apagado" | "administracion" | "sin_acceso") {
  const now = new Date()
  await tx
    .update(calendarFeed)
    .set({ status: "revocado", revokedAt: now, revokedBy: by, revokeReason: reason, updatedAt: now })
    .where(and(eq(calendarFeed.organizationId, orgId), eq(calendarFeed.id, feedId), eq(calendarFeed.status, "activo")))
  await purgeOldUses(tx, orgId, todayIn((await findOrgLocale(tx, orgId)).timezone, now))
}

/** Lo de más de 90 días se va en toda la clínica, también lo de enlaces ya cambiados o apagados. */
async function purgeOldUses(tx: Db, orgId: string, today: string): Promise<void> {
  await tx
    .delete(calendarFeedUse)
    .where(and(eq(calendarFeedUse.organizationId, orgId), lt(calendarFeedUse.day, daysBefore(today, CALENDAR_USE_KEEP_DAYS))))
}

/**
 * Suma un programa a los que la persona reconoce, en la misma sentencia: dos
 * pedidos a la vez (Google y el iPhone el primer día, o «Fui yo» mientras el
 * calendario consulta) no se pisan. Devuelve si lo sumó.
 */
async function rememberClient(tx: Db, orgId: string, feedId: string, client: CalendarClient): Promise<boolean> {
  const updated = await tx
    .update(calendarFeed)
    .set({ knownClients: sql`array_append(${calendarFeed.knownClients}, ${client}::text)`, updatedAt: new Date() })
    .where(and(eq(calendarFeed.organizationId, orgId), eq(calendarFeed.id, feedId), sql`not (${client}::text = any(${calendarFeed.knownClients}))`))
    .returning({ id: calendarFeed.id })
  return updated.length > 0
}

/** «Cambiar enlace»: el anterior deja de servir al momento y el nuevo empieza sin historial. */
export async function rotateMyCalendarFeed(tx: Db, orgId: string, userId: string, deps: CalendarFeedDeps): Promise<MyCalendarFeed> {
  await requireAttends(tx, orgId, userId)
  const feed = await activeFeed(tx, orgId, userId)
  if (!feed) throw notFound("Enlace del calendario")
  await revoke(tx, orgId, feed.id, userId, "cambiado")
  await insertFeed(tx, orgId, userId, deps, "calendar_feed.rotated")
  return getMyCalendarFeed(tx, orgId, userId, deps)
}

/** «Dejar de compartir». */
export async function revokeMyCalendarFeed(tx: Db, orgId: string, userId: string): Promise<void> {
  const feed = await activeFeed(tx, orgId, userId)
  if (!feed) return
  await revoke(tx, orgId, feed.id, userId, "apagado")
  await audit(tx, orgId, userId, "calendar_feed.revoked", feed.id)
}

/** «Fui yo»: ese programa queda como conocido y deja de avisar. */
export async function acknowledgeCalendarClient(tx: Db, orgId: string, userId: string, client: CalendarClient): Promise<void> {
  const feed = await activeFeed(tx, orgId, userId)
  if (!feed) return
  if (await rememberClient(tx, orgId, feed.id, client)) await audit(tx, orgId, userId, "calendar_feed.client_known", feed.id, { client })
  // El aviso de la campana de ese programa ya no hace falta.
  await tx
    .update(workspaceNotification)
    .set({ resolvedAt: sql`now()`, readAt: sql`coalesce(${workspaceNotification.readAt}, now())` })
    .where(
      and(
        eq(workspaceNotification.organizationId, orgId),
        eq(workspaceNotification.userId, userId),
        eq(workspaceNotification.dedupeKey, `calendario:${feed.id}:${client}`),
        isNull(workspaceNotification.resolvedAt),
      ),
    )
}

export interface TeamCalendarFeed {
  userId: string
  createdAt: string
  lastUsedAt: string | null
  /** Un programa que la persona no reconoció lo usó en los últimos 7 días. */
  newUse: boolean
}

/** Equipo: quién comparte su agenda. No da el enlace: ese es de cada uno. */
export async function listTeamCalendarFeeds(tx: Db, orgId: string, now = new Date()): Promise<TeamCalendarFeed[]> {
  const feeds = await tx
    .select()
    .from(calendarFeed)
    .where(and(eq(calendarFeed.organizationId, orgId), eq(calendarFeed.status, "activo")))
  if (feeds.length === 0) return []
  const today = todayIn((await findOrgLocale(tx, orgId)).timezone, now)
  const uses = await tx
    .select({ feedId: calendarFeedUse.feedId, client: calendarFeedUse.client, day: calendarFeedUse.day, lastAt: calendarFeedUse.lastAt })
    .from(calendarFeedUse)
    .where(and(eq(calendarFeedUse.organizationId, orgId), inArray(calendarFeedUse.feedId, feeds.map((feed) => feed.id))))
  const recentFrom = daysBefore(today, RECENT_DAYS - 1)
  return feeds.map((feed) => {
    const own = uses.filter((use) => use.feedId === feed.id)
    const last = own.reduce<Date | null>((at, use) => (!at || use.lastAt > at ? use.lastAt : at), null)
    return {
      userId: feed.userId,
      createdAt: feed.createdAt.toISOString(),
      lastUsedAt: last?.toISOString() ?? null,
      newUse: own.some((use) => isoDay(use.day) >= recentFrom && !feed.knownClients.includes(use.client)),
    }
  })
}

/** Equipo › «Dejar de compartir su agenda». */
export async function revokeTeamCalendarFeed(tx: Db, orgId: string, actorUserId: string, userId: string): Promise<void> {
  const feed = await activeFeed(tx, orgId, userId)
  if (!feed) throw notFound("Enlace del calendario")
  await revoke(tx, orgId, feed.id, actorUserId, "administracion")
  await audit(tx, orgId, actorUserId, "calendar_feed.revoked_by_admin", feed.id, { userId })
}

/**
 * La clínica de un token, sin contexto de organización (lo pide un calendario,
 * sin sesión). Con la conexión propietaria: solo lee la huella y la clínica.
 */
export async function findCalendarFeedOrg(ownerDb: Db, token: string): Promise<string | null> {
  if (!TOKEN_RE.test(token)) return null
  const [row] = await ownerDb
    .select({ organizationId: calendarFeed.organizationId })
    .from(calendarFeed)
    .where(and(eq(calendarFeed.tokenHash, tokenHashOf(token)), eq(calendarFeed.status, "activo")))
    .limit(1)
  return row?.organizationId ?? null
}

/** «R. P.»: la inicial del primer nombre y la del primer apellido. */
export function initialsOf(person: { givenNames: string | null; familyName: string | null; displayName: string }): string {
  const first = (text: string | null) => text?.trim().split(/\s+/)[0]?.charAt(0).toLocaleUpperCase("es") ?? ""
  const given = first(person.givenNames)
  const family = first(person.familyName)
  if (given || family) return [given, family].filter(Boolean).map((letter) => `${letter}.`).join(" ")
  const words = person.displayName.trim().split(/\s+/).filter(Boolean)
  return [words[0], words.length > 1 ? words[words.length - 1] : undefined]
    .filter((word): word is string => !!word)
    .map((word) => `${word.charAt(0).toLocaleUpperCase("es")}.`)
    .join(" ")
}

/**
 * Lo que entrega la dirección del calendario: anota quién la pidió y arma el
 * archivo con las citas de quien lo compartió. Nulo si el enlace ya no sirve.
 */
export async function serveCalendarFeed(
  tx: Db,
  orgId: string,
  token: string,
  userAgent: string | null | undefined,
  now = new Date(),
): Promise<string | null> {
  if (!TOKEN_RE.test(token)) return null
  const [feed] = await tx
    .select()
    .from(calendarFeed)
    .where(and(eq(calendarFeed.organizationId, orgId), eq(calendarFeed.tokenHash, tokenHashOf(token)), eq(calendarFeed.status, "activo")))
    .limit(1)
  if (!feed) return null
  if (!(await attends(tx, orgId, feed.userId))) {
    await revoke(tx, orgId, feed.id, null, "sin_acceso")
    await audit(tx, orgId, null, "calendar_feed.revoked_no_access", feed.id, { userId: feed.userId })
    return null
  }
  const clinicZone = (await findOrgLocale(tx, orgId)).timezone
  await recordUse(tx, orgId, feed, calendarClientOf(userAgent), todayIn(clinicZone, now), now)
  const platform = productWords(await orgProduct(tx, orgId)).name
  return calendarFeedFile(
    await feedName(tx, orgId, platform),
    await feedEvents(tx, orgId, feed.userId, clinicZone, now),
    60,
    platform,
  )
}

async function feedName(tx: Db, orgId: string, platform: string): Promise<string> {
  return `${(await clinicDisplayName(tx, orgId)) || platform} · Mis citas`
}

async function recordUse(
  tx: Db,
  orgId: string,
  feed: typeof calendarFeed.$inferSelect,
  client: CalendarClient,
  day: string,
  now: Date,
): Promise<void> {
  const [seen] = await tx
    .select({ client: calendarFeedUse.client })
    .from(calendarFeedUse)
    .where(and(eq(calendarFeedUse.organizationId, orgId), eq(calendarFeedUse.feedId, feed.id)))
    .limit(1)
  await tx
    .insert(calendarFeedUse)
    .values({ organizationId: orgId, feedId: feed.id, day, client, firstAt: now, lastAt: now })
    .onConflictDoUpdate({
      target: [calendarFeedUse.organizationId, calendarFeedUse.feedId, calendarFeedUse.day, calendarFeedUse.client],
      set: { hits: sql`${calendarFeedUse.hits} + 1`, lastAt: now },
    })
  await purgeOldUses(tx, orgId, day)
  if (feed.knownClients.includes(client)) return
  // El primer programa, y los del primer día, son de quien lo creó: no avisan.
  if (!seen || now.getTime() - feed.createdAt.getTime() < SETUP_MS) {
    await rememberClient(tx, orgId, feed.id, client)
    return
  }
  const time = new Intl.DateTimeFormat("es", { timeZone: (await findOrgLocale(tx, orgId)).timezone, hour: "2-digit", minute: "2-digit" }).format(now)
  await createWorkspaceNotification(tx, orgId, {
    userId: feed.userId,
    dedupeKey: `calendario:${feed.id}:${client}`,
    title: "Un programa nuevo usó el enlace de tu calendario",
    body: `${CALENDAR_CLIENT_LABELS[client]}, hoy a las ${time}. Si no fuiste tú, cambia el enlace: así nadie más ve tus citas.`,
    href: "/agenda?calendario=1",
    permission: "appointments.read",
  })
}

async function feedEvents(
  tx: Db,
  orgId: string,
  userId: string,
  clinicZone: string,
  now: Date,
  options: { from?: Date; limit?: number } = {},
): Promise<CalendarEvent[]> {
  const from = options.from ?? zonedTimeToUtc(todayIn(clinicZone, now), 0, clinicZone)
  const to = new Date(from.getTime() + CALENDAR_FEED_DAYS_AHEAD * 86_400_000)
  const rows = await tx
    .select({
      id: appointment.id,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      version: appointment.version,
      branchName: branch.name,
      branchAddress: branchAddressColumns,
      branchTimeZone: branch.timezone,
      roomName: scheduleRoom.name,
      givenNames: patientPerson.givenNames,
      familyName: patientPerson.familyName,
      displayName: patientPerson.displayName,
    })
    .from(appointment)
    .innerJoin(branch, eq(branch.id, appointment.branchId))
    .innerJoin(patient, and(eq(patient.organizationId, appointment.organizationId), eq(patient.id, appointment.patientId)))
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .leftJoin(scheduleRoom, eq(scheduleRoom.id, appointment.roomId))
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.professionalUserId, userId),
        ne(appointment.status, "cancelada"),
        // Una cita de prueba no va al calendario del profesional (ADR 0094).
        eq(appointment.isTest, false),
        gte(appointment.startsAt, from),
        lt(appointment.startsAt, to),
      ),
    )
    .orderBy(asc(appointment.startsAt))
    .limit(options.limit ?? 2000)
  const origin = await clinicOriginOf(tx, orgId)
  const clinic = (await clinicDisplayName(tx, orgId)) || "la clínica"
  // La plataforma de la clínica: «Ábrela en latidIA» en un consultorio (issue 229).
  const platform = productWords(await orgProduct(tx, orgId)).name
  const addressText = await branchAddressWriter(tx, orgId)
  return rows.map((row) => {
    const address = addressText(row.branchAddress)
    return {
      uid: `${row.id}@odentia`,
      sequence: Math.max(0, row.version - 1),
      start: row.startsAt,
      end: row.endsAt,
      timeZone: row.branchTimeZone ?? clinicZone,
      summary: `Paciente · ${initialsOf(row)}`,
      location: [[`Sede ${row.branchName}`, row.roomName].filter(Boolean).join(" · "), address].filter(Boolean).join(", "),
      description: origin
        ? `Cita de ${clinic}. Ábrela en ${platform} para ver quién es: ${origin}/agenda?appointmentId=${row.id}`
        : `Cita de ${clinic}. Ábrela en ${platform} para ver quién es.`,
      stamp: now,
    }
  })
}
