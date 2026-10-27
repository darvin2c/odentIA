import type { Db } from "@odentia/db"
import { reportQuestion } from "@odentia/db/schema/reports"
import { saasAction, saasCharge, saasSubscription, storageUsageDay } from "@odentia/db/schema/saas-billing"
import { and, asc, desc, eq, gte, lt, notInArray, sql } from "drizzle-orm"
import { ServiceError } from "./errors.js"
import {
  currentSaasPeriod,
  getActionPricing,
  insertAction,
  microsToCents,
  priceFor,
  STORAGE_GB_BYTES,
} from "./saas-actions.js"
import { findOrgLocale } from "./locale.js"
import { moneyText } from "./saas-emails.js"
import { getAgentSpendGate } from "./saas-terms.js"

/* ---------- Argos: preguntas incluidas y paquetes (ADR 0085) ---------- */

/** Lo que no gasta preguntas: lo que Argos no pudo responder y lo que fue a la Ayuda o a otra cosa. */
export const FREE_OUTCOMES = ["no_pudo", "ayuda", "otro"]

export interface ArgosAllowance {
  /** false: el plan no cobra paquetes; Argos responde sin contar. */
  limited: boolean
  included: number
  /** Preguntas sumadas con paquetes en el mes, con las que siguen de un paquete del final del mes anterior. */
  added: number
  /** De `added`, las que siguen del paquete comprado en los últimos días del mes anterior (D3). */
  carried: number
  used: number
  remaining: number
  packQuestions: number
  packBaseMicros: number | null
  packPriceMicros: number | null
  currency: string | null
  autoPack: boolean
  periodEnd: Date
}

/** Un paquete comprado en estos últimos días del mes dura hasta el cierre del siguiente (D3 del lienzo). */
export const ARGOS_PACK_CARRY_DAYS = 7

/** Las preguntas que gastan en un tramo. */
export async function questionsUsed(tx: Db, orgId: string, from: Date, to: Date): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(reportQuestion)
    .where(
      and(
        eq(reportQuestion.organizationId, orgId),
        eq(reportQuestion.usedModel, true),
        notInArray(reportQuestion.outcome, FREE_OUTCOMES),
        gte(reportQuestion.createdAt, from),
        lt(reportQuestion.createdAt, to),
      ),
    )
  return row?.n ?? 0
}

/** Las preguntas sumadas con paquetes en un tramo. */
async function packUnits(tx: Db, orgId: string, from: Date, to: Date): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(sum(${saasAction.units}), 0)::int` })
    .from(saasAction)
    .where(
      and(
        eq(saasAction.organizationId, orgId),
        eq(saasAction.kind, "preguntas"),
        gte(saasAction.occurredAt, from),
        lt(saasAction.occurredAt, to),
      ),
    )
  return row?.n ?? 0
}

/**
 * Lo que sigue en este mes de un paquete comprado en los últimos días del
 * anterior (D3): lo que le quedaba al cerrar ese mes, sin pasar de lo que
 * sumaron esos paquetes. El mes anterior es el del último cargo que terminó
 * donde empieza este; sin cargo, uno del mismo largo. No arrastra lo que a su
 * vez venía de dos meses atrás: comprar al final de dos meses seguidos es raro
 * y solo cuenta de menos.
 */
async function carriedQuestions(tx: Db, orgId: string, period: { start: Date; end: Date }, included: number): Promise<number> {
  const late = await packUnits(tx, orgId, new Date(period.start.getTime() - ARGOS_PACK_CARRY_DAYS * 86_400_000), period.start)
  if (!late) return 0
  const [previous] = await tx
    .select({ start: saasCharge.periodStart })
    .from(saasCharge)
    .where(and(eq(saasCharge.organizationId, orgId), eq(saasCharge.periodEnd, period.start)))
    .orderBy(desc(saasCharge.createdAt))
    .limit(1)
  const start = previous?.start ?? new Date(period.start.getTime() - (period.end.getTime() - period.start.getTime()))
  const left = included + (await packUnits(tx, orgId, start, period.start)) - (await questionsUsed(tx, orgId, start, period.start))
  return Math.min(late, Math.max(0, left))
}

/**
 * Las preguntas a Argos del mes de la clínica: las incluidas del plan, las
 * sumadas con paquetes (y las que siguen de un paquete del final del mes
 * anterior) y las usadas. Cuentan las que pasaron por un modelo que se paga
 * (`used_model`), salvo las que no pudo responder y las que fueron a la Ayuda
 * o a otra cosa.
 */
export async function getArgosAllowance(
  tx: Db,
  orgId: string,
  now = new Date(),
): Promise<ArgosAllowance> {
  const period = await currentSaasPeriod(tx, orgId, now)
  const pricing = await getActionPricing(tx, orgId, now)
  const [sub] = await tx
    .select({ autoPack: saasSubscription.argosAutoPack })
    .from(saasSubscription)
    .where(eq(saasSubscription.organizationId, orgId))
    .limit(1)
  const pack = priceFor(pricing, "preguntas")
  const included = pricing.argos.included
  const carried = await carriedQuestions(tx, orgId, period, included)
  const added = (await packUnits(tx, orgId, period.start, period.end)) + carried
  const count = await questionsUsed(tx, orgId, period.start, period.end)
  return {
    limited: pack.basePriceMicros !== null,
    included,
    added,
    carried,
    used: count,
    remaining: Math.max(0, included + added - count),
    packQuestions: pricing.argos.packQuestions,
    packBaseMicros: pack.basePriceMicros,
    packPriceMicros: pack.priceMicros,
    currency: pricing.currency,
    autoPack: sub?.autoPack ?? false,
    periodEnd: period.end,
  }
}

/**
 * El mes de la clínica como lo dice el panel: el del día en que cierra («Del
 * 11 de octubre al 10 de noviembre» es noviembre) y ese último día.
 */
async function periodWords(tx: Db, orgId: string, periodEnd: Date): Promise<{ month: string; lastDay: string }> {
  const { locale, timezone } = await findOrgLocale(tx, orgId)
  const last = new Date(periodEnd.getTime() - 1)
  return {
    month: new Intl.DateTimeFormat(locale, { month: "long", timeZone: timezone }).format(last),
    lastDay: new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: timezone }).format(last),
  }
}

const budgetReachedText = (month: string) =>
  `Llegaste al presupuesto de ${month}, así que no puedo sumar más preguntas. Súbelo en Plan y pagos y sigo respondiendo.`

/**
 * Suma un paquete de preguntas a Argos en el mes de la clínica (ADR 0085):
 * con el permiso de quien administra la clínica o, si encendió «Sumar
 * solas», sin preguntar. Se cobra en la factura del mes, como todo. Con el
 * presupuesto del mes alcanzado no se suma: el presupuesto es el límite.
 */
export async function addArgosPack(tx: Db, orgId: string, input: { automatic: boolean; now?: Date }): Promise<ArgosAllowance & { packAdded: boolean }> {
  const now = input.now ?? new Date()
  const first = await getArgosAllowance(tx, orgId, now)
  if (!first.limited) throw new ServiceError("ARGOS_PACK_UNAVAILABLE", 409, "Tu plan no tiene paquetes de preguntas a Argos")
  if ((await getAgentSpendGate(tx, orgId, now)).capReached) {
    throw new ServiceError("ARGOS_BUDGET_REACHED", 409, budgetReachedText((await periodWords(tx, orgId, first.periodEnd)).month))
  }
  const period = await currentSaasPeriod(tx, orgId, now)
  // Dos compras a la vez (dos preguntas con «Sumar solas», un doble clic) no suman dos paquetes
  // por el mismo agotamiento: con el bloqueo se vuelve a mirar, y si la otra ya sumó, no se suma otro.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`argos-pack:${orgId}`}, 0))`)
  const before = await getArgosAllowance(tx, orgId, now)
  if (before.remaining > 0) return { ...before, packAdded: false }
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(saasAction)
    .where(and(eq(saasAction.organizationId, orgId), eq(saasAction.kind, "preguntas"), gte(saasAction.occurredAt, period.start), lt(saasAction.occurredAt, period.end)))
  await insertAction(tx, orgId, "preguntas", {
    units: before.packQuestions,
    occurredAt: now,
    detail: input.automatic
      ? `Sumó ${before.packQuestions} preguntas a Argos solas, como pediste en Plan y pagos`
      : `Sumó ${before.packQuestions} preguntas a Argos`,
    dedupeKey: `preguntas:${period.start.toISOString()}:${(count?.n ?? 0) + 1}`,
  })
  return { ...(await getArgosAllowance(tx, orgId, now)), packAdded: true }
}

/** Lo que dice Argos al sumar un paquete: con el permiso de quien administra o solo. */
export async function argosPackAddedText(tx: Db, orgId: string, allowance: ArgosAllowance, automatic: boolean): Promise<string> {
  const price = moneyText(allowance.currency ?? "USD", microsToCents(allowance.packPriceMicros ?? 0))
  return automatic
    ? `Sumé ${allowance.packQuestions} preguntas por ${price}, como pediste en Plan y pagos. Te quedan ${allowance.remaining}.`
    : `Listo: sumé ${allowance.packQuestions} preguntas por ${price}. Te quedan ${allowance.remaining} hasta el ${(await periodWords(tx, orgId, allowance.periodEnd)).lastDay}.`
}

/**
 * Antes de una pregunta que pasa por el modelo: si quedan preguntas, sigue;
 * si no, suma un paquete solo si la clínica lo pidió (y lo dice), o pide
 * permiso con `ARGOS_QUESTIONS_USED` (lo que dice el panel de Argos). Con el
 * presupuesto del mes alcanzado responde lo incluido y no suma
 * (`ARGOS_BUDGET_REACHED`).
 */
export async function ensureArgosQuestion(tx: Db, orgId: string, now = new Date()): Promise<{ added: string | null }> {
  const allowance = await getArgosAllowance(tx, orgId, now)
  if (!allowance.limited || allowance.remaining > 0) return { added: null }
  const words = await periodWords(tx, orgId, allowance.periodEnd)
  if ((await getAgentSpendGate(tx, orgId, now)).capReached) throw new ServiceError("ARGOS_BUDGET_REACHED", 409, budgetReachedText(words.month))
  if (allowance.autoPack) {
    const after = await addArgosPack(tx, orgId, { automatic: true, now })
    // Si otra pregunta a la vez ya sumó el paquete, esta solo lo usa: lo dijo la otra.
    return { added: after.packAdded ? await argosPackAddedText(tx, orgId, after, true) : null }
  }
  const total = allowance.included + allowance.added
  const price = moneyText(allowance.currency ?? "USD", microsToCents(allowance.packPriceMicros ?? 0))
  throw new ServiceError(
    "ARGOS_QUESTIONS_USED",
    409,
    `Usaste las ${total} preguntas de ${words.month}. ¿Sumo ${allowance.packQuestions} más por ${price}? Las uso para responder esta pregunta y las que vengan hasta el ${words.lastDay}.`,
  )
}

export interface ArgosPanelAllowance {
  limited: boolean
  used: number
  /** Las incluidas más las sumadas con paquetes. */
  total: number
  remaining: number
  /** «noviembre» y «10 de noviembre»: el mes de la clínica en palabras. */
  month: string
  lastDay: string
  packQuestions: number
  /** «USD 3»; null si el plan no tiene paquetes. */
  packPrice: string | null
  autoPack: boolean
  budgetReached: boolean
}

/** Lo que dice el panel de Argos arriba («150 de 300 preguntas de noviembre») y en su tarjeta (tablero C3). */
export async function getArgosPanelAllowance(tx: Db, orgId: string, now = new Date()): Promise<ArgosPanelAllowance> {
  const allowance = await getArgosAllowance(tx, orgId, now)
  const words = await periodWords(tx, orgId, allowance.periodEnd)
  return {
    limited: allowance.limited,
    used: allowance.used,
    total: allowance.included + allowance.added,
    remaining: allowance.remaining,
    month: words.month,
    lastDay: words.lastDay,
    packQuestions: allowance.packQuestions,
    packPrice: allowance.packPriceMicros === null ? null : moneyText(allowance.currency ?? "USD", microsToCents(allowance.packPriceMicros)),
    autoPack: allowance.autoPack,
    budgetReached: (await getAgentSpendGate(tx, orgId, now)).capReached,
  }
}

/** «Sumar solas» en Plan y pagos: al acabar las preguntas, se suma un paquete sin preguntar. */
export async function setArgosAutoPack(tx: Db, orgId: string, on: boolean): Promise<void> {
  await tx
    .update(saasSubscription)
    .set({ argosAutoPack: on, updatedAt: new Date() })
    .where(eq(saasSubscription.organizationId, orgId))
}

/* ---------- Almacenamiento por GB (ADR 0085) ---------- */

/** Día UTC de una fecha, como se guarda la medición. */
export const storageDayOf = (date: Date): string => date.toISOString().slice(0, 10)

/**
 * Mide lo que tiene guardado cada clínica hoy (con owner, lo llama el reloj
 * SaaS una vez por día): documentos de pacientes, tomografías y adjuntos de
 * conversaciones guardados en odentIA. Repetirlo el mismo día lo reemplaza.
 */
export async function recordStorageUsage(tx: Db, now = new Date()): Promise<number> {
  const day = storageDayOf(now)
  const rows = (await tx.execute(sql`
    insert into storage_usage_day (organization_id, day, bytes, measured_at)
    select o.id, ${day}, coalesce(d.bytes, 0) + coalesce(i.bytes, 0) + coalesce(m.bytes, 0), now()
    from organization o
    left join (select organization_id, sum(size_bytes)::bigint as bytes from patient_document group by organization_id) d on d.organization_id = o.id
    left join (select organization_id, sum(total_bytes)::bigint as bytes from imaging_study group by organization_id) i on i.organization_id = o.id
    left join (
      select organization_id, sum((att->>'size')::bigint)::bigint as bytes
      from message, jsonb_array_elements(case when jsonb_typeof(attachments) = 'array' then attachments else '[]'::jsonb end) att
      where att ? 'objectKey' and att->>'size' ~ '^[0-9]+$'
      group by organization_id
    ) m on m.organization_id = o.id
    on conflict (organization_id, day) do update set bytes = excluded.bytes, measured_at = excluded.measured_at
    returning organization_id`)) as unknown as Array<{ organization_id: string }>
  return rows.length
}

export interface StorageUsage {
  /** Lo guardado en la última medición; null si aún no se midió. */
  bytes: number | null
  includedGb: number
  gbBaseMicros: number | null
  gbPriceMicros: number | null
  currency: string | null
}

/** Lo que tiene guardado la clínica (la última medición) y lo que incluye su plan. */
export async function getStorageUsage(
  tx: Db,
  orgId: string,
  now = new Date(),
): Promise<StorageUsage> {
  const pricing = await getActionPricing(tx, orgId, now)
  const [last] = await tx
    .select({ bytes: storageUsageDay.bytes })
    .from(storageUsageDay)
    .where(eq(storageUsageDay.organizationId, orgId))
    .orderBy(sql`${storageUsageDay.day} desc`)
    .limit(1)
  const gb = priceFor(pricing, "almacenamiento")
  return {
    bytes: last?.bytes ?? null,
    includedGb: pricing.storageIncludedGb,
    gbBaseMicros: gb.basePriceMicros,
    gbPriceMicros: gb.priceMicros,
    currency: pricing.currency,
  }
}

/**
 * Al cerrar el mes (con owner): el promedio de lo guardado cada día del
 * tramo, menos los GB incluidos, redondeado al GB entero de arriba. Se cobra
 * como una fila del mes, una sola vez por tramo. Sin precio por GB en el
 * plan, nada.
 */
export async function countStorageAction(
  tx: Db,
  orgId: string,
  period: { start: Date; end: Date },
): Promise<boolean> {
  const pricing = await getActionPricing(tx, orgId, period.start)
  if (pricing.prices.almacenamiento === null) return false
  const days = await tx
    .select({ bytes: storageUsageDay.bytes })
    .from(storageUsageDay)
    .where(
      and(
        eq(storageUsageDay.organizationId, orgId),
        gte(storageUsageDay.day, storageDayOf(period.start)),
        lt(storageUsageDay.day, storageDayOf(period.end)),
      ),
    )
    .orderBy(asc(storageUsageDay.day))
  if (!days.length) return false
  const averageGb = days.reduce((sum, row) => sum + row.bytes, 0) / days.length / STORAGE_GB_BYTES
  const extra = Math.ceil(averageGb - pricing.storageIncludedGb)
  if (extra <= 0) return false
  const shown = averageGb.toLocaleString("es", { maximumFractionDigits: 1 })
  return insertAction(tx, orgId, "almacenamiento", {
    units: extra,
    occurredAt: new Date(period.end.getTime() - 1),
    detail: `Guardó ${shown} GB en promedio: ${extra} GB por encima de los ${pricing.storageIncludedGb} incluidos`,
    dedupeKey: `almacenamiento:${period.start.toISOString()}`,
  })
}
