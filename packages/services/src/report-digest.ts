/**
 * El resumen del lunes (decisión 10 de Reportes v2; ADR 0071): un correo con
 * cuatro cifras de la semana, lo que cambió y una recomendación de Argos, que
 * cada persona con Reportes prende para sí (nace apagado). Lo arma el sistema
 * con las mismas cifras del catálogo y frases fijas, sin modelo: no puede
 * contradecir a la pantalla. No lleva datos clínicos ni nombres de pacientes.
 *
 * Sale el lunes desde las 8:00 en la zona de la clínica y cubre de lunes a
 * domingo de la semana anterior. Se reserva antes de enviarlo
 * (`report_digest_send`, una fila por persona y semana): un envío incierto no
 * se repite. Si la semana no tuvo movimientos, o la persona ya no ve Reportes,
 * no se envía y queda dicho por qué.
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import { canAccess, seesBilling } from "@odentia/auth/permissions"
import type { Db } from "@odentia/db"
import { reportDigest, reportDigestSend } from "@odentia/db/schema/reports"
import { renderEmail, type MailTemplate } from "@odentia/mail"
import { and, eq, sql } from "drizzle-orm"
import { getAdminRecommendations, getAdminSettings } from "./agent-admin.js"
import { collectedNetMany } from "./finance.js"
import { clinicOrigin } from "./public-links.js"
import { agentBookedMany } from "./report-agent.js"
import { appointmentsByProfessional } from "./report-agenda.js"
import { type FigureContext, formatFigure, type FigureValue, reportFigureOf } from "./report-figures.js"
import { goalsForMonth } from "./report-goals.js"
import { addDays, currentMonthIn, monthStart } from "./report-periods.js"
import { reportScope, type ReportScope } from "./report-scope.js"
import {
  absoluteChangeWords,
  capitalize,
  civilDaysWords,
  countWords,
  monthWords,
  POINT_WORDS,
  percentWords,
  rateOf,
  relativeChangeWords,
  whole,
} from "./report-words.js"

/** La hora del lunes, en la zona de la clínica, desde la que sale el resumen. */
export const REPORT_DIGEST_HOUR = 8

export async function getReportDigest(tx: Db, orgId: string, userId: string): Promise<{ enabled: boolean }> {
  const [row] = await tx
    .select({ enabled: reportDigest.enabled })
    .from(reportDigest)
    .where(and(eq(reportDigest.organizationId, orgId), eq(reportDigest.userId, userId)))
    .limit(1)
  return { enabled: row?.enabled ?? false }
}

export async function setReportDigest(tx: Db, orgId: string, userId: string, enabled: boolean, now: Date = new Date()): Promise<{ enabled: boolean }> {
  await tx
    .insert(reportDigest)
    .values({ organizationId: orgId, userId, enabled, updatedAt: now })
    .onConflictDoUpdate({ target: [reportDigest.organizationId, reportDigest.userId], set: { enabled, updatedAt: now } })
  return { enabled }
}

// --- «Dejar de recibirlo» sin entrar ------------------------------------------------------

function signature(secretsKey: Buffer, payload: string): string {
  return createHmac("sha256", secretsKey).update(`resumen-lunes:${payload}`).digest("base64url")
}

/** El enlace del correo para apagarlo sin entrar: la clínica y la persona, firmadas. */
export function reportDigestToken(secretsKey: Buffer, orgId: string, userId: string): string {
  const payload = Buffer.from(JSON.stringify([orgId, userId])).toString("base64url")
  return `${payload}.${signature(secretsKey, payload)}`
}

export function readReportDigestToken(secretsKey: Buffer, token: string): { orgId: string; userId: string } | null {
  const [payload, sig] = token.split(".")
  if (!payload || !sig || payload.length > 400) return null
  const expected = Buffer.from(signature(secretsKey, payload))
  const given = Buffer.from(sig)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const [orgId, userId] = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown[]
    return typeof orgId === "string" && typeof userId === "string" ? { orgId, userId } : null
  } catch {
    return null
  }
}

// --- Cuándo y a quién --------------------------------------------------------------------

export interface DueReportDigest {
  orgId: string
  userId: string
  /** El lunes en que empezó la semana que cubre (`YYYY-MM-DD`). */
  week: string
}

/**
 * Las personas a las que les toca su resumen ahora: lunes desde las 8:00 en la
 * zona de su clínica y sin el de esa semana. Con la conexión del dueño: recorre
 * todas las clínicas.
 */
export async function dueReportDigests(ownerDb: Db, now: Date = new Date()): Promise<DueReportDigest[]> {
  const at = sql`${now.toISOString()}::timestamptz`
  const rows = await ownerDb.execute<{ orgId: string; userId: string; week: string }>(sql`
    select d.organization_id as "orgId", d.user_id as "userId",
      to_char((${at} at time zone op.timezone)::date - 7, 'YYYY-MM-DD') as week
    from report_digest d
    join org_profile op on op.organization_id = d.organization_id
    where d.enabled
      and extract(isodow from (${at} at time zone op.timezone)) = 1
      and extract(hour from (${at} at time zone op.timezone)) >= ${REPORT_DIGEST_HOUR}
      and not exists (
        select 1 from report_digest_send s
        where s.organization_id = d.organization_id and s.user_id = d.user_id
          and s.week = (${at} at time zone op.timezone)::date - 7
      )
    order by d.organization_id, d.user_id
    limit 200`)
  return [...rows]
}

/** Reserva el resumen de esa semana antes de armarlo: si ya estaba, no se vuelve a enviar. */
export async function claimReportDigest(tx: Db, orgId: string, userId: string, week: string): Promise<string | null> {
  const [row] = await tx
    .insert(reportDigestSend)
    .values({ organizationId: orgId, userId, week })
    .onConflictDoNothing()
    .returning({ id: reportDigestSend.id })
  return row?.id ?? null
}

export async function completeReportDigest(
  tx: Db,
  orgId: string,
  id: string,
  state: "enviado" | "incierto" | "omitido",
  detail: string | null = null,
  now: Date = new Date(),
): Promise<void> {
  await tx
    .update(reportDigestSend)
    .set({ state, detail: detail?.slice(0, 500) ?? null, ...(state === "enviado" ? { sentAt: now } : {}) })
    .where(and(eq(reportDigestSend.organizationId, orgId), eq(reportDigestSend.id, id), eq(reportDigestSend.state, "reclamado")))
}

// --- Lo que dice -------------------------------------------------------------------------

const SAME_WEEK = "que la semana anterior"

function changeText(key: string, current: FigureValue, previous: FigureValue, scope: ReportScope): string {
  if (current.value === null) return "Sin datos"
  const { locale } = scope
  const change =
    key === "cobrado"
      ? relativeChangeWords(current.value, previous.value, SAME_WEEK, locale)
      : key === "no_vinieron"
        ? previous.value === null
          ? null
          : absoluteChangeWords(current.value, previous.value, SAME_WEEK, locale, (value) => countWords(value, POINT_WORDS, locale))
        : absoluteChangeWords(current.value, previous.value, SAME_WEEK, locale)
  return change ? capitalize(change.text, locale) : "Sin la semana anterior para comparar"
}

export type ReportDigestComposed =
  | { skip: "sin_permiso" | "sin_correo" | "sin_movimientos" }
  | { to: string; mail: MailTemplate }

/**
 * Arma el resumen de una persona para la semana que empezó en `week`. Vuelve a
 * mirar si sigue en la clínica y si ve Reportes: quien perdió el permiso deja
 * de recibirlo.
 */
export async function composeReportDigest(
  tx: Db,
  orgId: string,
  userId: string,
  week: string,
  deps: { secretsKey: Buffer; now?: Date },
): Promise<ReportDigestComposed> {
  const now = deps.now ?? new Date()
  const [person] = await tx.execute<{ role: string; email: string | null; name: string; slug: string; clinic: string }>(sql`
    select m.role, u.email, u.name, o.slug, coalesce(op.trade_name, o.name) as clinic
    from member m
    join "user" u on u.id = m.user_id
    join organization o on o.id = m.organization_id
    left join org_profile op on op.organization_id = m.organization_id
    where m.organization_id = ${orgId} and m.user_id = ${userId}
    limit 1`)
  if (!person || !canAccess(person.role, "reports.read")) return { skip: "sin_permiso" }
  if (!person.email) return { skip: "sin_correo" }

  const period = `${week}..${addDays(week, 6)}`
  const scope = await reportScope(tx, orgId, { period }, now)
  const ctx: FigureContext = { tx, orgId, scope, billing: seesBilling(person.role) }
  const spans = [scope.window, scope.window.previous]
  const keys = ["cobrado", "atendidas", "pacientes_nuevos", "no_vinieron"] as const
  const values = new Map<string, FigureValue[]>()
  for (const key of keys) values.set(key, await reportFigureOf(key)!.values(ctx, spans, undefined))
  const now0 = (key: string): FigureValue => values.get(key)?.[0] ?? { value: null }
  const before = (key: string): FigureValue => values.get(key)?.[1] ?? { value: null }
  const quiet = (now0("cobrado").value ?? 0) === 0 && (now0("atendidas").value ?? 0) === 0 && (now0("pacientes_nuevos").value ?? 0) === 0 && (now0("no_vinieron").whole ?? 0) === 0
  if (quiet) return { skip: "sin_movimientos" }

  const { locale, currency } = scope
  const facts = keys.map((key) => {
    const figure = reportFigureOf(key)!
    const value = now0(key)
    const shown = value.value === null ? "Sin datos" : formatFigure(value.value, figure.unit, scope)
    return { label: key === "cobrado" ? "Cobrado" : figure.name, value: `${shown} · ${changeText(key, value, before(key), scope)}` }
  })

  // Lo que cambió: hechos de la semana, con frases fijas.
  const changes: string[] = []
  const noShow = now0("no_vinieron")
  const noShowBefore = before("no_vinieron")
  if (noShow.value !== null && noShowBefore.value !== null && Math.abs(noShow.value - noShowBefore.value) >= 2) {
    const rose = noShow.value > noShowBefore.value
    let line = `No vinieron ${rose ? "subió" : "bajó"} a ${percentWords(noShow.value, locale)}`
    if (rose && (noShow.part ?? 0) >= 2) {
      const people = await appointmentsByProfessional(tx, orgId, scope.window, now, undefined)
      const top = people.sort((a, b) => b.noShow - a.noShow)[0]
      if (top && top.noShow >= 2 && top.noShow < (noShow.part ?? 0)) line += `: ${whole(top.noShow, locale)} de las ${whole(noShow.part ?? 0, locale)} citas eran de ${top.name}`
    }
    changes.push(`${line}.`)
  }
  const [booked, bookedBefore] = await agentBookedMany(tx, orgId, undefined, spans)
  if ((booked?.booked ?? 0) + (bookedBefore?.booked ?? 0) > 0) {
    changes.push(`El agente agendó ${countWords(booked?.booked ?? 0, { one: "cita", many: "citas" }, locale)}; la semana anterior, ${whole(bookedBefore?.booked ?? 0, locale)}.`)
  }
  const month = currentMonthIn(scope.timezone, now)
  const goal = (await goalsForMonth(tx, orgId, month)).cobrado
  if (goal && goal.currency === currency) {
    const start = monthStart(scope.timezone, month.year, month.month)
    const next = month.month === 12 ? monthStart(scope.timezone, month.year + 1, 1) : monthStart(scope.timezone, month.year, month.month + 1)
    const [collected] = await collectedNetMany(tx, orgId, [{ start, end: now }])
    const cents = collected?.find((item) => item.currency === currency)?.cents ?? 0
    const reached = rateOf(cents, goal.amount) ?? 0
    const elapsed = Math.round(((now.getTime() - start.getTime()) * 100) / (next.getTime() - start.getTime()))
    changes.push(`${capitalize(monthWords(month, locale), locale)} va en el ${percentWords(reached, locale)} de tu meta de cobrado, con el ${percentWords(elapsed, locale)} del mes.`)
  }

  // Lo que recomienda Argos, si está encendido: la primera de sus recomendaciones, con lo que ve esta persona.
  const blocks: Array<{ title: string; text: string }> = []
  if ((await getAdminSettings(tx, orgId)).enabled) {
    const advice = await getAdminRecommendations(tx, orgId, (permission) => canAccess(person.role, permission))
    const first = advice.recommendations[0]
    if (first) blocks.push({ title: "Argos te recomienda", text: `${first.title}. Con «${first.name}» prendida: ${first.description}` })
  }

  const origin = clinicOrigin(person.slug)
  const mail = reportDigestEmail({
    firstName: person.name.split(/\s+/)[0] ?? person.name,
    clinic: person.clinic,
    week: civilDaysWords({ from: week, to: addDays(week, 6) }, locale),
    collected: formatFigure(now0("cobrado").value ?? 0, "money", scope),
    facts,
    changes,
    recommendation: blocks.find((block) => block.title === "Argos te recomienda")?.text ?? null,
    reportsUrl: origin ? `${origin}/reports?period=${encodeURIComponent(period)}` : null,
    stopUrl: origin ? `${origin}/resumen-lunes/baja/${reportDigestToken(deps.secretsKey, orgId, userId)}` : null,
  })
  return { to: person.email, mail }
}

export interface ReportDigestEmailInput {
  firstName: string
  clinic: string
  /** «del 12 al 18 de octubre de 2026». */
  week: string
  /** Lo cobrado en la semana, ya escrito: va en el asunto. */
  collected: string
  facts: Array<{ label: string; value: string }>
  changes: string[]
  recommendation: string | null
  reportsUrl: string | null
  stopUrl: string | null
}

/** El correo del resumen del lunes (tablero A4), con el molde común: cifras, lo que cambió, la recomendación y el botón. */
export function reportDigestEmail(input: ReportDigestEmailInput): MailTemplate {
  const things = input.changes.length + (input.recommendation ? 1 : 0)
  return renderEmail({
    subject: `Tu semana: ${input.collected} cobrados${things > 0 ? ` y ${things} ${things === 1 ? "cosa" : "cosas"} que mirar` : ""}`,
    preview: `Así fue la semana ${input.week} en ${input.clinic}.`,
    eyebrow: input.clinic,
    title: "El resumen del lunes",
    paragraphs: [`Hola, ${input.firstName}. Así fue la semana ${input.week} en ${input.clinic}.`],
    facts: input.facts,
    blocks: [
      ...(input.changes.length > 0 ? [{ title: "Lo que cambió", items: input.changes }] : []),
      ...(input.recommendation ? [{ title: "Argos te recomienda", text: input.recommendation }] : []),
    ],
    ...(input.reportsUrl ? { action: { label: "Ver Reportes", url: input.reportsUrl } } : {}),
    note: "Lo arma odentIA con las mismas cifras de Reportes y frases fijas; no lo escribe un modelo. No lleva datos clínicos ni nombres de pacientes.",
    reason: "Lo recibes porque lo prendiste en Reportes.",
    ...(input.stopUrl ? { unsubscribe: { label: "Dejar de recibirlo", url: input.stopUrl } } : {}),
  })
}
