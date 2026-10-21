import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { saasCommercialTerms } from "@odentia/db/schema/saas-billing"
import { asc, desc, eq, lte, sql } from "drizzle-orm"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import { ServiceError, validation } from "./errors.js"

/**
 * Condiciones comerciales (issue 167, ADR 0074): las reglas que acompañan al
 * precio y valen para todas las clínicas (plazos, porcentajes, avisos). Viven
 * en `saas_commercial_terms` como versiones: un cambio agrega una fila que rige
 * desde que se guarda y nada se reescribe. Cada regla se lee con la versión del
 * día en que empezó lo que mide (la reserva, el cargo, la entrada en gracia…),
 * así lo que ya empezó conserva la regla que tenía.
 *
 * Lo que no está aquí a propósito: el peor costo de cada acción y el mínimo del
 * doble (`saas-terms.ts`), que salen de medir la IA y no de una decisión.
 */

export interface SaasCommercialTerms {
  conversationWindowHours: number
  recoveryWindowDays: number
  reviewAutoPercent: number
  reviewAnswerDays: number
  reviewReadDays: number
  paymentDays: number
  graceDays: number
  proofExtensionDays: number
  proofExtensionMax: number
  halfCycleDays: number
  trialDays: number
  warnPercent: number
  alarmPercent: number
  waitlistAnswerDays: number
  commissionMonths: number
  discountNoticeDays: number
  guaranteeNoticeDays: number
}
export type SaasTermKey = keyof SaasCommercialTerms

/**
 * Los valores que estaban en el código: la primera versión, que guarda la
 * migración 0051. Solo se usan si la tabla está vacía.
 */
export const SAAS_TERMS_INITIAL: Readonly<SaasCommercialTerms> = Object.freeze({
  conversationWindowHours: 24,
  recoveryWindowDays: 7,
  reviewAutoPercent: 10,
  reviewAnswerDays: 2,
  reviewReadDays: 7,
  paymentDays: 7,
  graceDays: 7,
  proofExtensionDays: 3,
  proofExtensionMax: 1,
  halfCycleDays: 15,
  trialDays: 30,
  warnPercent: 75,
  alarmPercent: 90,
  waitlistAnswerDays: 2,
  commissionMonths: 12,
  discountNoticeDays: 15,
  guaranteeNoticeDays: 30,
})

/* ---------- Palabras ---------- */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const hours = (n: number) => plural(n, "hora", "horas")
const days = (n: number) => plural(n, "día", "días")
const businessDays = (n: number) => plural(n, "día hábil", "días hábiles")
const percent = (n: number) => `${n} %`
const times = (n: number) => plural(n, "vez", "veces")
const months = (n: number) => plural(n, "mes", "meses")

/** Cómo se dice cada cifra («24 horas», «2 días hábiles»): lo usan la sección, el historial y los errores. */
export const SAAS_TERM_WORDS: Record<SaasTermKey, (n: number) => string> = {
  conversationWindowHours: hours,
  recoveryWindowDays: days,
  reviewAutoPercent: percent,
  reviewAnswerDays: businessDays,
  reviewReadDays: days,
  paymentDays: days,
  graceDays: days,
  proofExtensionDays: days,
  proofExtensionMax: times,
  halfCycleDays: days,
  trialDays: days,
  warnPercent: percent,
  alarmPercent: percent,
  waitlistAnswerDays: businessDays,
  commissionMonths: months,
  discountNoticeDays: days,
  guaranteeNoticeDays: days,
}

export interface SaasTermField {
  key: SaasTermKey
  /** El nombre corto, para el historial y los errores. */
  name: string
  /** Lo que dice el campo del cajón. */
  label: string
  /** La palabra a la derecha de la cifra. */
  unit: string
  min: number
  max: number
  hint: string
  /** Desde cuándo rige un cambio (decisión 1 del lienzo). */
  since: string
  /** Va en la misma fila que el campo anterior. */
  sameRow?: boolean
}

export type SaasTermsGroupKey = "cobro" | "revision" | "pagos" | "prueba" | "invitaciones" | "fin"

/** Un trozo de frase: la cifra va resaltada. */
export interface SaasTermsPart {
  text: string
  strong?: boolean
}

interface GroupSpec {
  key: SaasTermsGroupKey
  title: string
  fields: SaasTermField[]
  sentences: (t: SaasCommercialTerms) => SaasTermsPart[][]
}

const v = (text: string): SaasTermsPart => ({ text, strong: true })
const t = (text: string): SaasTermsPart => ({ text })

const GROUPS: GroupSpec[] = [
  {
    key: "cobro",
    title: "Qué se cobra",
    fields: [
      {
        key: "conversationWindowHours",
        name: "Una conversación por persona",
        label: "Una conversación por persona cada",
        unit: "horas",
        min: 1,
        max: 72,
        hint: "Entre 1 y 72 horas.",
        since: "Para los mensajes que lleguen desde ahora.",
      },
      {
        key: "recoveryWindowDays",
        name: "Plazo de la cita recuperada",
        label: "La cita cuenta como recuperada si la persona reserva hasta",
        unit: "días después del mensaje de Argos",
        min: 1,
        max: 30,
        hint: "Entre 1 y 30 días.",
        since: "Para las reservas que se hagan desde ahora. Una reserva hecha conserva su plazo.",
      },
    ],
    sentences: (x) => [
      [t("Una conversación por persona cada "), v(hours(x.conversationWindowHours)), t(", aunque escriba diez mensajes o cambie de canal.")],
      [t("Una cita cuenta como recuperada si la persona reserva hasta "), v(days(x.recoveryWindowDays)), t(" después del mensaje de Argos y asiste.")],
    ],
  },
  {
    key: "revision",
    title: "Revisión de cobros",
    fields: [
      {
        key: "reviewAutoPercent",
        name: "Spam que se devuelve al instante",
        label: "Devolver el spam al instante, sin revisar, hasta el",
        unit: "% de las conversaciones del mes",
        min: 0,
        max: 30,
        hint: "Entre 0 y 30. Con 0, todo pasa por revisión.",
        since: "Para las revisiones que se pidan desde ahora.",
      },
      {
        key: "reviewAnswerDays",
        name: "Responder una revisión",
        label: "Responder una revisión en",
        unit: "días hábiles",
        min: 1,
        max: 10,
        hint: "Entre 1 y 10 días hábiles.",
        since: "Para las revisiones que se pidan desde ahora.",
      },
      {
        key: "reviewReadDays",
        name: "Leer la conversación revisada",
        label: "Si la clínica lo permite, leer la conversación durante",
        unit: "días",
        min: 1,
        max: 30,
        hint: "Entre 1 y 30 días.",
        since: "Para los permisos que se den desde ahora.",
      },
    ],
    sentences: (x) => [
      [t("El spam se devuelve al instante, sin revisar, hasta el "), v(percent(x.reviewAutoPercent)), t(" de las conversaciones del mes.")],
      [t("Lo demás lo respondemos en "), v(businessDays(x.reviewAnswerDays)), t(".")],
      [t("Si la clínica lo permite, leemos la conversación revisada durante "), v(days(x.reviewReadDays)), t(".")],
    ],
  },
  {
    key: "pagos",
    title: "Pagos",
    fields: [
      {
        key: "paymentDays",
        name: "Días para pagar un cargo",
        label: "Días para pagar un cargo",
        unit: "días",
        min: 1,
        max: 30,
        hint: "Entre 1 y 30. Después empieza la gracia.",
        since: "Para los cargos que se emitan desde ahora. Los ya emitidos conservan su plazo.",
      },
      {
        key: "graceDays",
        name: "Días de gracia",
        label: "Días de gracia antes de restringir",
        unit: "días",
        min: 1,
        max: 30,
        hint: "Entre 1 y 30.",
        since: "Para las clínicas que entren en gracia desde ahora. Las que ya están en gracia siguen con su fecha.",
      },
      {
        key: "proofExtensionDays",
        name: "Espera por un comprobante",
        label: "Con un comprobante por confirmar, esperar",
        unit: "días más",
        min: 0,
        max: 10,
        hint: "De 0 a 10 días.",
        since: "Para los comprobantes que lleguen desde ahora.",
      },
      {
        key: "proofExtensionMax",
        name: "Veces que se espera por cargo",
        label: "Veces por cargo",
        unit: "veces",
        min: 0,
        max: 3,
        hint: "De 0 a 3. Con 0 no se espera.",
        since: "Para los comprobantes que lleguen desde ahora.",
        sameRow: true,
      },
      {
        key: "halfCycleDays",
        name: "Cobro quincenal",
        label: "Con ciclo quincenal, cobrar lo que pasó del crédito a los",
        unit: "días del tramo",
        min: 7,
        max: 21,
        hint: "Entre 7 y 21.",
        since: "Para los tramos que empiecen desde ahora.",
      },
    ],
    sentences: (x) => [
      [t("La clínica tiene "), v(days(x.paymentDays)), t(" para pagar un cargo.")],
      [t("Si no paga, "), v(days(x.graceDays)), t(" de gracia antes de restringir.")],
      x.proofExtensionMax === 0 || x.proofExtensionDays === 0
        ? [t("Con un comprobante por confirmar, "), v("no se espera más"), t(".")]
        : [t("Con un comprobante por confirmar, se espera "), v(days(x.proofExtensionDays)), t(" más, "), v(times(x.proofExtensionMax)), t(" por cargo.")],
      [t("Con ciclo quincenal, lo que pasó del crédito se cobra a los "), v(days(x.halfCycleDays)), t(" del tramo.")],
    ],
  },
  {
    key: "prueba",
    title: "Prueba y avisos del tope",
    fields: [
      {
        key: "trialDays",
        name: "Prueba sin plan por defecto",
        label: "Días de prueba cuando no hay un plan por defecto",
        unit: "días",
        min: 7,
        max: 90,
        hint: "Entre 7 y 90. Cada plan tiene sus propios días: esto solo vale si no hay ninguno por defecto.",
        since: "Para las clínicas que se abran desde ahora.",
      },
      {
        key: "warnPercent",
        name: "Aviso del tope de gasto",
        label: "Avisar al usar",
        unit: "% del tope",
        min: 50,
        max: 99,
        hint: "Entre 50 y 99, antes que la alarma.",
        since: "Desde ya: solo avisan.",
      },
      {
        key: "alarmPercent",
        name: "Alarma del tope de gasto",
        label: "Alarma al usar",
        unit: "% del tope",
        min: 50,
        max: 99,
        hint: "Entre 50 y 99. Al 100 % los casos nuevos pasan al equipo.",
        since: "Desde ya: solo avisan.",
      },
    ],
    sentences: (x) => [
      [t("Prueba de "), v(days(x.trialDays)), t(" cuando no hay un plan por defecto.")],
      [t("Aviso al usar el "), v(percent(x.warnPercent)), t(" del tope de gasto y alarma al "), v(percent(x.alarmPercent)), t(".")],
    ],
  },
  {
    key: "invitaciones",
    title: "Invitaciones y vendedores",
    fields: [
      {
        key: "waitlistAnswerDays",
        name: "Responder una solicitud de invitación",
        label: "Responder una solicitud de invitación en",
        unit: "días hábiles",
        min: 1,
        max: 10,
        hint: "Entre 1 y 10 días hábiles.",
        since: "Para las solicitudes que lleguen desde ahora.",
      },
      {
        key: "commissionMonths",
        name: "Meses de comisión del vendedor",
        label: "El vendedor cobra comisión durante los primeros",
        unit: "meses de la clínica",
        min: 1,
        max: 36,
        hint: "Entre 1 y 36 meses.",
        since: "Para las clínicas que entren desde ahora.",
      },
    ],
    sentences: (x) => [
      [t("Una solicitud de invitación se responde en "), v(businessDays(x.waitlistAnswerDays)), t(".")],
      [t("El vendedor cobra comisión durante los primeros "), v(months(x.commissionMonths)), t(" de la clínica.")],
    ],
  },
  {
    key: "fin",
    title: "Avisos antes de que termine algo",
    fields: [
      {
        key: "discountNoticeDays",
        name: "Aviso del fin de un precio especial",
        label: "Avisar que termina un precio especial",
        unit: "días antes",
        min: 1,
        max: 30,
        hint: "Entre 1 y 30. Lo ven la clínica y el Inicio de la administración.",
        since: "Desde ya: solo avisan.",
      },
      {
        key: "guaranteeNoticeDays",
        name: "Aviso del fin de las condiciones de una Fundadora",
        label: "Avisar que terminan las condiciones garantizadas de una Fundadora",
        unit: "días antes",
        min: 1,
        max: 60,
        hint: "Entre 1 y 60. Después pasa al plan por defecto.",
        since: "Desde ya: solo avisan.",
      },
    ],
    sentences: (x) => [
      [t("Un precio especial se avisa "), v(days(x.discountNoticeDays)), t(" antes de que termine.")],
      [t("Las condiciones garantizadas de una Fundadora se avisan "), v(days(x.guaranteeNoticeDays)), t(" antes de que terminen.")],
    ],
  },
]

const FIELDS: SaasTermField[] = GROUPS.flatMap((group) => group.fields)
const FIELD_BY_KEY = new Map(FIELDS.map((field) => [field.key, field]))
/** Las claves en el orden de la pantalla. */
export const SAAS_TERM_KEYS: SaasTermKey[] = FIELDS.map((field) => field.key)

/** «2 días hábiles», «1 día hábil». */
export const businessDaysWords = businessDays

/** Suma `days` días hábiles (lunes a viernes) a `from`: los plazos que se prometen en días hábiles. */
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

/* ---------- Leer ---------- */

type TermsRow = typeof saasCommercialTerms.$inferSelect

function valuesOf(row: TermsRow): SaasCommercialTerms {
  return Object.fromEntries(SAAS_TERM_KEYS.map((key) => [key, row[key]])) as unknown as SaasCommercialTerms
}

/** La versión vigente en `at`: la última que empezó a regir hasta ese instante. */
export async function saasTermsAt(tx: Db, at: Date): Promise<SaasCommercialTerms> {
  const [row] = await tx
    .select()
    .from(saasCommercialTerms)
    .where(lte(saasCommercialTerms.effectiveFrom, at))
    .orderBy(desc(saasCommercialTerms.effectiveFrom))
    .limit(1)
  return row ? valuesOf(row) : { ...SAAS_TERMS_INITIAL }
}

/** Las que rigen ahora. */
export function currentSaasTerms(tx: Db, now = new Date()): Promise<SaasCommercialTerms> {
  return saasTermsAt(tx, now)
}

/** Todas las versiones, de la primera a la última: para leer muchas fechas con una sola consulta. */
export interface SaasTermsTimeline {
  at(date: Date): SaasCommercialTerms
}

export async function loadSaasTermsTimeline(tx: Db): Promise<SaasTermsTimeline> {
  const rows = await tx.select().from(saasCommercialTerms).orderBy(asc(saasCommercialTerms.effectiveFrom))
  const versions = rows.map((row) => ({ from: row.effectiveFrom.getTime(), values: valuesOf(row) }))
  return {
    at(date: Date) {
      let found: SaasCommercialTerms | null = null
      for (const version of versions) {
        if (version.from > date.getTime()) break
        found = version.values
      }
      return { ...(found ?? SAAS_TERMS_INITIAL) }
    },
  }
}

/** Lo que la clínica puede saber de las condiciones (Plan y pagos, «Pedir revisión», Reportes). */
export interface ClinicSaasTerms {
  conversationWindowHours: number
  recoveryWindowDays: number
  reviewAutoPercent: number
  reviewAnswerDays: number
  reviewReadDays: number
  halfCycleDays: number
  warnPercent: number
  alarmPercent: number
  guaranteeNoticeDays: number
}

export async function getClinicSaasTerms(tx: Db, now = new Date()): Promise<ClinicSaasTerms> {
  const x = await currentSaasTerms(tx, now)
  return {
    conversationWindowHours: x.conversationWindowHours,
    recoveryWindowDays: x.recoveryWindowDays,
    reviewAutoPercent: x.reviewAutoPercent,
    reviewAnswerDays: x.reviewAnswerDays,
    reviewReadDays: x.reviewReadDays,
    halfCycleDays: x.halfCycleDays,
    warnPercent: x.warnPercent,
    alarmPercent: x.alarmPercent,
    guaranteeNoticeDays: x.guaranteeNoticeDays,
  }
}

/* ---------- La sección de la administración ---------- */

export interface SaasTermsVersionInfo {
  id: string | null
  effectiveFrom: Date | null
  createdByName: string | null
  reason: string | null
  /** La primera versión: los valores que estaban en el código. */
  initial: boolean
}

export interface SaasTermsView {
  version: SaasTermsVersionInfo
  values: SaasCommercialTerms
  groups: Array<{ key: SaasTermsGroupKey; title: string; sentences: SaasTermsPart[][]; fields: SaasTermField[] }>
}

async function latestRow(tx: Db): Promise<(TermsRow & { createdByName: string | null }) | null> {
  const [row] = await tx
    .select({ terms: saasCommercialTerms, createdByName: user.name })
    .from(saasCommercialTerms)
    .leftJoin(user, eq(user.id, saasCommercialTerms.createdBy))
    .orderBy(desc(saasCommercialTerms.effectiveFrom))
    .limit(1)
  return row ? { ...row.terms, createdByName: row.createdByName } : null
}

/** Las condiciones vigentes con sus frases y sus campos: la sección y el cajón no escriben texto propio. */
export async function getSaasTermsView(tx: Db): Promise<SaasTermsView> {
  const row = await latestRow(tx)
  const values = row ? valuesOf(row) : { ...SAAS_TERMS_INITIAL }
  return {
    version: {
      id: row?.id ?? null,
      effectiveFrom: row?.effectiveFrom ?? null,
      createdByName: row?.createdByName ?? null,
      reason: row?.reason ?? null,
      initial: !row || row.createdBy === null,
    },
    values,
    groups: GROUPS.map((group) => ({ key: group.key, title: group.title, sentences: group.sentences(values), fields: group.fields })),
  }
}

export interface SaasTermsChange {
  key: SaasTermKey
  name: string
  before: string
  after: string
}

export interface SaasTermsVersionRow {
  id: string
  effectiveFrom: Date
  createdByName: string | null
  reason: string | null
  initial: boolean
  /** Lo que cambió respecto de la versión anterior; vacío en la primera. */
  changes: SaasTermsChange[]
  /** La primera versión: cada regla con su cifra en palabras. */
  summary: Array<{ key: SaasTermKey; name: string; value: string }> | null
}

function changesBetween(before: SaasCommercialTerms, after: SaasCommercialTerms): SaasTermsChange[] {
  return SAAS_TERM_KEYS.filter((key) => before[key] !== after[key]).map((key) => ({
    key,
    name: FIELD_BY_KEY.get(key)!.name,
    before: SAAS_TERM_WORDS[key](before[key]),
    after: SAAS_TERM_WORDS[key](after[key]),
  }))
}

/** «Ver cambios»: del más reciente al primero, con lo que cambió en palabras. */
export async function listSaasTermsVersions(tx: Db): Promise<SaasTermsVersionRow[]> {
  const rows = await tx
    .select({ terms: saasCommercialTerms, createdByName: user.name })
    .from(saasCommercialTerms)
    .leftJoin(user, eq(user.id, saasCommercialTerms.createdBy))
    .orderBy(asc(saasCommercialTerms.effectiveFrom))
  const out: SaasTermsVersionRow[] = []
  let previous: SaasCommercialTerms | null = null
  for (const { terms, createdByName } of rows) {
    const values = valuesOf(terms)
    out.push({
      id: terms.id,
      effectiveFrom: terms.effectiveFrom,
      createdByName,
      reason: terms.reason,
      initial: previous === null,
      changes: previous ? changesBetween(previous, values) : [],
      summary: previous
        ? null
        : SAAS_TERM_KEYS.map((key) => ({ key, name: FIELD_BY_KEY.get(key)!.name, value: SAAS_TERM_WORDS[key](values[key]) })),
    })
    previous = values
  }
  return out.reverse()
}

/* ---------- Cambiar ---------- */

export interface SetSaasTermsInput {
  /** Solo las cifras que se cambian; las demás siguen como están. */
  values: Partial<SaasCommercialTerms>
  /** La versión que se tenía a la vista al editar: si otra persona guardó antes, se avisa. */
  basedOn: string | null
  reason?: string | null
}

/** El mismo límite que la base (`saas_commercial_terms_limits_check`), dicho junto al campo. */
export function checkSaasTerms(values: SaasCommercialTerms): Array<{ key: SaasTermKey; message: string }> {
  const errors: Array<{ key: SaasTermKey; message: string }> = []
  for (const field of FIELDS) {
    const value = values[field.key]
    if (!Number.isInteger(value) || value < field.min || value > field.max) {
      errors.push({ key: field.key, message: `${field.name}: escribe un número entero entre ${field.min} y ${field.max}.` })
    }
  }
  if (!errors.some((e) => e.key === "warnPercent" || e.key === "alarmPercent") && values.warnPercent >= values.alarmPercent) {
    errors.push({ key: "warnPercent", message: `El aviso va antes que la alarma: escribe menos de ${values.alarmPercent} %.` })
  }
  return errors
}

/**
 * Guarda una versión nueva con lo que cambió (solo la administración). Rige
 * desde `now`; lo que ya empezó conserva la regla anterior. Guardar sin
 * cambios no crea una versión. Si alguien guardó mientras se editaba, avisa en
 * vez de pisar su cambio.
 */
export async function setSaasTerms(tx: Db, actor: AdminActor, input: SetSaasTermsInput, now = new Date()): Promise<SaasTermsView> {
  if (actor.role !== "admin") throw new ServiceError("FORBIDDEN", 403, "Solo la administración de odentIA cambia las condiciones comerciales")
  for (const key of Object.keys(input.values)) {
    if (!FIELD_BY_KEY.has(key as SaasTermKey)) throw validation(`No existe la condición «${key}»`)
  }
  const reason = input.reason?.trim() || null
  if (reason && reason.length > 500) throw validation("El motivo admite hasta 500 caracteres")

  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('saas_commercial_terms', 0))`)
  const current = await latestRow(tx)
  if ((current?.id ?? null) !== input.basedOn) {
    throw new ServiceError(
      "TERMS_CHANGED",
      409,
      "Alguien cambió estas condiciones mientras las editabas. Revisa las cifras nuevas y vuelve a guardar.",
    )
  }
  const before = current ? valuesOf(current) : { ...SAAS_TERMS_INITIAL }
  const after: SaasCommercialTerms = { ...before, ...input.values }
  const errors = checkSaasTerms(after)
  if (errors.length > 0) throw validation(errors[0]!.message)
  const changes = changesBetween(before, after)
  if (changes.length === 0) return getSaasTermsView(tx)

  // Una versión empieza después de la anterior aunque el reloj diga lo mismo.
  const effectiveFrom = current && current.effectiveFrom >= now ? new Date(current.effectiveFrom.getTime() + 1) : now
  const [row] = await tx
    .insert(saasCommercialTerms)
    .values({ ...after, effectiveFrom, reason, createdBy: actor.userId })
    .returning({ id: saasCommercialTerms.id })
  await writeAdminAudit(tx, actor, {
    action: "saas.terms_changed",
    entityId: row!.id,
    metadata: {
      changes: changes.map((change) => ({ key: change.key, before: before[change.key], after: after[change.key] })),
      ...(reason ? { reason } : {}),
    },
  })
  return getSaasTermsView(tx)
}
