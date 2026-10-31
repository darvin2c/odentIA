import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { professionalSpecialty } from "@odentia/db/schema/clinical-forms"
import { orgSpecialty, type PriceDisclosure, serviceCatalog, treatmentTemplate } from "@odentia/db/schema/clinical"
import { professionalSchedule, scheduleBlock } from "@odentia/db/schema/availability"
import { branch } from "@odentia/db/schema/org"
import { and, asc, eq, gt, inArray, isNull, lt } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { createHash } from "node:crypto"
import { getAgentConfig } from "./agentConfig.js"
import { getClinicInfoSnapshot, normalizeForSearch } from "./knowledge.js"
import { findOrgCountry, formatOrgMoney, type OrgLocale } from "./locale.js"
import { kindOfSpecialty } from "./product-catalog.js"
import { productHooks } from "./products.js"
import { listClinicPromotionSummaries } from "./promotions.js"

/**
 * Lo que «Informar» le da al agente de la clínica (ADR 0021): horarios de
 * atención de cada sede, profesionales y especialidades, servicios y
 * promociones con su precio dicho como la clínica lo eligió. Todo sale de la
 * base al momento; nada se escribe dos veces ni lo pone un modelo.
 *
 * Una clínica chica entra entera en el prompt (sin una llamada de más); una
 * grande se consulta con `searchClinic`, que devuelve solo lo que coincide.
 */
export const SERVICES_IN_PROMPT = 40
/**
 * Nombres que caben en el índice por especialidad de una clínica grande. Más
 * allá se dice cuántos quedan fuera: el índice orienta, la búsqueda encuentra.
 */
export const SERVICES_IN_INDEX = 300
/** Resultados de cada tipo que devuelve una búsqueda en la clínica; lo que pasa de ahí se cuenta. */
export const CLINIC_SEARCH_LIMIT = 6
/**
 * Servicios cuyo precio dice el agente en una conversación (decisión 4 de la
 * fase 4). Nunca manda el tarifario: responde lo que le preguntan y, pasado
 * este número, ofrece la evaluación. Lo cuenta el código con lo que ya dijo.
 */
export const PRICES_PER_CONVERSATION = 3
export const PROMOTIONS_IN_PROMPT = 10
export const PROFESSIONALS_IN_PROMPT = 30
/** Cuántos días hacia adelante se avisan los cierres de una sede. */
export const CLOSURE_DAYS = 14

const WEEKDAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"] as const

export interface AgentPrice {
  disclosure: PriceDisclosure
  priceCents: number
  currency: string
  /** La evaluación que se ofrece cuando el precio no es exacto. */
  evaluation: { name: string; priceCents: number; currency: string; disclosure: PriceDisclosure } | null
}

export interface AgentServiceInfo {
  id: string
  name: string
  /** La especialidad de la clínica, con su nombre (ADR 0039). */
  specialty: string | null
  /**
   * Su tipo de tratamiento (ADR 0069): el de su tratamiento de la biblioteca o
   * el de su especialidad del país. Las palabras de la calle del índice van
   * con él; null con una especialidad que creó la clínica.
   */
  kind: string | null
  durationMin: number | null
  price: AgentPrice
}

export interface AgentPromotionInfo {
  id: string
  name: string
  endsAt: string | null
  conditions: string | null
  items: Array<{
    serviceName: string
    disclosure: PriceDisclosure
    priceCents: number
    currency: string
    tariffCents: number
    /** Cómo dice el precio el propio servicio: la tarifa solo se compara si es exacta. */
    serviceDisclosure: PriceDisclosure
  }>
}

export interface AgentBranchHours {
  id: string
  name: string
  /** Por día de la semana (0 = domingo), los tramos en que atiende alguien, en minutos locales. */
  week: Array<{ weekday: number; ranges: Array<[number, number]> }>
  /** Cierres de toda la sede en los próximos días. */
  closures: Array<{ startsAt: string; endsAt: string; reason: string | null }>
}

export interface AgentProfessionalInfo {
  /** Usuario del profesional: solo para encontrarlo, nunca se le dice al modelo. */
  id: string
  /**
   * Lo que sí se le dice al modelo: un identificador que solo sirve para
   * pedir los huecos de esa persona en `buscar_huecos` (decisión 16).
   */
  ref: string
  name: string
  specialties: string[]
  where: Array<{ branchName: string; weekdays: number[] }>
}

/** Une tramos que se tocan o se pisan: el horario de la sede es la suma de los de su equipo. */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = []
  for (const [start, end] of sorted) {
    const last = out[out.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else out.push([start, end])
  }
  return out
}

/**
 * Horario de atención de cada sede activa, derivado de los horarios del equipo,
 * y sus próximos cierres. Es el mismo que dice el agente y el que muestra
 * «Horarios y ausencias» (`branchId`: solo esa sede): no hay otro horario de
 * la sede que se escriba aparte (ADR 0117).
 */
export async function getBranchHours(
  tx: Db,
  orgId: string,
  now = new Date(),
  opts: { branchId?: string } = {},
): Promise<AgentBranchHours[]> {
  const branches = await tx
    .select({ id: branch.id, name: branch.name })
    .from(branch)
    .where(
      and(
        eq(branch.organizationId, orgId),
        eq(branch.isActive, true),
        opts.branchId ? eq(branch.id, opts.branchId) : undefined,
      ),
    )
    .orderBy(asc(branch.name), asc(branch.id))
  if (!branches.length) return []
  const ids = branches.map((row) => row.id)
  const schedules = await tx
    .select({
      branchId: professionalSchedule.branchId,
      weekday: professionalSchedule.weekday,
      startMin: professionalSchedule.startMin,
      endMin: professionalSchedule.endMin,
    })
    .from(professionalSchedule)
    .where(
      and(
        eq(professionalSchedule.organizationId, orgId),
        eq(professionalSchedule.isActive, true),
        inArray(professionalSchedule.branchId, ids),
      ),
    )
  const until = new Date(now.getTime() + CLOSURE_DAYS * 86_400_000)
  // Un cierre de sede es un bloqueo sin profesional ni unidad dental: afecta a todos.
  const closures = await tx
    .select({
      branchId: scheduleBlock.branchId,
      startsAt: scheduleBlock.startsAt,
      endsAt: scheduleBlock.endsAt,
      reason: scheduleBlock.reason,
    })
    .from(scheduleBlock)
    .where(
      and(
        eq(scheduleBlock.organizationId, orgId),
        inArray(scheduleBlock.branchId, ids),
        isNull(scheduleBlock.professionalUserId),
        isNull(scheduleBlock.roomId),
        gt(scheduleBlock.endsAt, now),
        lt(scheduleBlock.startsAt, until),
      ),
    )
    .orderBy(asc(scheduleBlock.startsAt))
  return branches.map((row) => {
    const week: AgentBranchHours["week"] = []
    for (let weekday = 0; weekday < 7; weekday++) {
      const ranges = mergeRanges(
        schedules
          .filter((item) => item.branchId === row.id && item.weekday === weekday)
          .map((item): [number, number] => [item.startMin, item.endMin]),
      )
      if (ranges.length) week.push({ weekday, ranges })
    }
    return {
      id: row.id,
      name: row.name,
      week,
      closures: closures
        .filter((item) => item.branchId === row.id)
        .map((item) => ({ startsAt: item.startsAt.toISOString(), endsAt: item.endsAt.toISOString(), reason: item.reason })),
    }
  })
}

/**
 * Identificador del profesional para el agente: no es su usuario y solo
 * sirve para pedir sus huecos (`resolveProfessionalRef`). Estable por
 * clínica, así vale entre turnos.
 */
export function professionalRef(orgId: string, userId: string): string {
  return `pro-${createHash("sha256").update(`${orgId}:${userId}`).digest("hex").slice(0, 10)}`
}

/** El profesional con ese identificador, si tiene horario en la clínica; nulo si no es de nadie. */
export async function resolveProfessionalRef(tx: Db, orgId: string, ref: string): Promise<string | null> {
  const wanted = ref.trim()
  if (!/^pro-[0-9a-f]{10}$/.test(wanted)) return null
  const rows = await tx
    .selectDistinct({ userId: professionalSchedule.professionalUserId })
    .from(professionalSchedule)
    .where(and(eq(professionalSchedule.organizationId, orgId), eq(professionalSchedule.isActive, true)))
  return rows.find((row) => professionalRef(orgId, row.userId) === wanted)?.userId ?? null
}

/**
 * Quien atiende: los profesionales con horario activo, con sus especialidades
 * y en qué sede y qué días. Solo nombre y especialidad; nada más de la persona.
 */
export async function listAgentProfessionals(tx: Db, orgId: string): Promise<AgentProfessionalInfo[]> {
  const rows = await tx
    .select({
      userId: professionalSchedule.professionalUserId,
      name: user.name,
      branchName: branch.name,
      weekday: professionalSchedule.weekday,
    })
    .from(professionalSchedule)
    .innerJoin(user, eq(user.id, professionalSchedule.professionalUserId))
    .innerJoin(branch, eq(branch.id, professionalSchedule.branchId))
    .where(
      and(
        eq(professionalSchedule.organizationId, orgId),
        eq(professionalSchedule.isActive, true),
        eq(branch.isActive, true),
      ),
    )
    .orderBy(asc(user.name), asc(branch.name))
  if (!rows.length) return []
  const specialties = await tx
    .select({ userId: professionalSpecialty.userId, name: orgSpecialty.name })
    .from(professionalSpecialty)
    .innerJoin(orgSpecialty, eq(orgSpecialty.id, professionalSpecialty.specialtyId))
    .where(and(eq(professionalSpecialty.organizationId, orgId), eq(orgSpecialty.isActive, true)))
    .orderBy(asc(orgSpecialty.name))
  const byUser = new Map<string, AgentProfessionalInfo>()
  for (const row of rows) {
    let item = byUser.get(row.userId)
    if (!item) {
      item = {
        id: row.userId,
        ref: professionalRef(orgId, row.userId),
        name: row.name,
        specialties: specialties.filter((s) => s.userId === row.userId).map((s) => s.name),
        where: [],
      }
      byUser.set(row.userId, item)
    }
    let place = item.where.find((w) => w.branchName === row.branchName)
    if (!place) {
      place = { branchName: row.branchName, weekdays: [] }
      item.where.push(place)
    }
    if (!place.weekdays.includes(row.weekday)) place.weekdays.push(row.weekday)
  }
  for (const item of byUser.values()) for (const place of item.where) place.weekdays.sort((a, b) => a - b)
  return [...byUser.values()]
}

const evaluationService = alias(serviceCatalog, "evaluation_service")

/** Servicios activos con su precio dicho como la clínica lo eligió; `ids` acota a esos. */
export async function listAgentServices(
  tx: Db,
  orgId: string,
  options: { ids?: string[]; limit?: number } = {},
): Promise<AgentServiceInfo[]> {
  if (options.ids && options.ids.length === 0) return []
  const conditions = [
    eq(serviceCatalog.organizationId, orgId),
    eq(serviceCatalog.isActive, true),
  ]
  if (options.ids) conditions.push(inArray(serviceCatalog.id, options.ids))
  const query = tx
    .select({
      id: serviceCatalog.id,
      name: serviceCatalog.name,
      specialty: orgSpecialty.name,
      specialtyKey: orgSpecialty.key,
      templateKind: treatmentTemplate.kind,
      durationMin: serviceCatalog.durationMin,
      priceCents: serviceCatalog.priceCents,
      currency: serviceCatalog.currency,
      disclosure: serviceCatalog.priceDisclosure,
      evaluationName: evaluationService.name,
      evaluationPriceCents: evaluationService.priceCents,
      evaluationCurrency: evaluationService.currency,
      evaluationDisclosure: evaluationService.priceDisclosure,
      evaluationActive: evaluationService.isActive,
    })
    .from(serviceCatalog)
    .leftJoin(
      orgSpecialty,
      and(eq(orgSpecialty.organizationId, serviceCatalog.organizationId), eq(orgSpecialty.id, serviceCatalog.specialtyId)),
    )
    .leftJoin(treatmentTemplate, eq(treatmentTemplate.id, serviceCatalog.templateId))
    .leftJoin(
      evaluationService,
      and(eq(evaluationService.id, serviceCatalog.evaluationServiceId), eq(evaluationService.organizationId, orgId)),
    )
    .where(and(...conditions))
    .orderBy(asc(serviceCatalog.name), asc(serviceCatalog.id))
  const rows = options.limit ? await query.limit(options.limit) : await query
  const { catalog } = await productHooks(tx, orgId)
  const specialties = catalog.specialties(await findOrgCountry(tx, orgId))
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    specialty: row.specialty,
    kind: row.templateKind ?? kindOfSpecialty(catalog, specialties, row.specialtyKey),
    durationMin: row.durationMin,
    price: {
      disclosure: row.disclosure as PriceDisclosure,
      priceCents: row.priceCents,
      currency: row.currency,
      evaluation:
        row.evaluationName && row.evaluationActive && row.evaluationPriceCents !== null && row.evaluationCurrency
          ? {
              name: row.evaluationName,
              priceCents: row.evaluationPriceCents,
              currency: row.evaluationCurrency,
              disclosure: (row.evaluationDisclosure ?? "exacto") as PriceDisclosure,
            }
          : null,
    },
  }))
}

/** Promociones vigentes con lo que el agente necesita para decirlas bien. */
export async function listAgentPromotions(tx: Db, orgId: string, at = new Date()): Promise<AgentPromotionInfo[]> {
  const live = await listClinicPromotionSummaries(tx, orgId, at)
  const serviceIds = [...new Set(live.flatMap((promo) => promo.items.map((item) => item.serviceId)))]
  const own = serviceIds.length
    ? new Map(
        (
          await tx
            .select({ id: serviceCatalog.id, disclosure: serviceCatalog.priceDisclosure })
            .from(serviceCatalog)
            .where(and(eq(serviceCatalog.organizationId, orgId), inArray(serviceCatalog.id, serviceIds)))
        ).map((row) => [row.id, row.disclosure as PriceDisclosure]),
      )
    : new Map<string, PriceDisclosure>()
  return live.map((promo) => ({
    id: promo.id,
    name: promo.name,
    endsAt: promo.endsAt ? promo.endsAt.toISOString() : null,
    conditions: promo.conditions,
    items: promo.items.map((item) => ({
      serviceName: item.serviceName,
      disclosure: item.priceDisclosure,
      priceCents: item.priceCents,
      currency: item.currency,
      tariffCents: item.tariffCents,
      // Sin dato, se asume lo más prudente: no comparar con la tarifa.
      serviceDisclosure: own.get(item.serviceId) ?? "evaluacion",
    })),
  }))
}

/* ---------- Cómo se le dice al modelo ---------- */

type Zone = Pick<OrgLocale, "locale" | "timezone">

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

/**
 * El precio tal como puede decirlo el agente. «desde» lleva la palabra pegada
 * al número: la comprobación antes de enviar no deja salir ese importe sin
 * ella. «evaluacion» no lleva ningún número: el agente no puede decirlo.
 */
export function formatAgentPrice(price: AgentPrice, zone: Pick<OrgLocale, "locale">): string {
  const evaluation = price.evaluation
    ? ` Ofrece la evaluación: ${price.evaluation.name}${
        price.evaluation.disclosure === "evaluacion"
          ? ""
          : price.evaluation.disclosure === "desde"
            ? `, desde ${formatOrgMoney(price.evaluation.priceCents, price.evaluation.currency, zone)}`
            : `, ${formatOrgMoney(price.evaluation.priceCents, price.evaluation.currency, zone)}`
      }.`
    : " Ofrece agendar una evaluación."
  if (price.disclosure === "exacto") return formatOrgMoney(price.priceCents, price.currency, zone)
  if (price.disclosure === "desde") {
    return `desde ${formatOrgMoney(price.priceCents, price.currency, zone)} (es un mínimo: el precio final se define en la evaluación; dilo siempre con «desde»).${evaluation}`
  }
  return `precio solo tras una evaluación: no digas ningún monto de este servicio.${evaluation}`
}

export function formatAgentService(service: AgentServiceInfo, zone: Pick<OrgLocale, "locale">): string {
  return `- ${service.name} (id ${service.id})${service.durationMin ? `, ${service.durationMin} min` : ""}: ${formatAgentPrice(service.price, zone)}`
}

/** Que el precio de una promoción no se confunda con el del servicio. */
export const PROMOTION_RULE = "Un precio de promoción se dice siempre como de la promoción: con su nombre, sus condiciones y hasta cuándo vale, nunca como el precio del servicio."

export function formatAgentPromotion(promo: AgentPromotionInfo, zone: Zone): string {
  const until = promo.endsAt
    ? ` Vigente hasta el ${new Date(promo.endsAt).toLocaleDateString(zone.locale, { timeZone: zone.timezone, day: "numeric", month: "long" })}.`
    : ""
  const items = promo.items
    .map((item) => {
      const tariff = formatOrgMoney(item.tariffCents, item.currency, zone)
      if (item.disclosure === "evaluacion") return `${item.serviceName}: con la promoción; el precio se define en la evaluación (no digas montos)`
      const amount = formatOrgMoney(item.priceCents, item.currency, zone)
      return item.disclosure === "desde"
        ? `${item.serviceName}: desde ${amount} (mínimo; dilo con «desde»)`
        : // La tarifa y el ahorro solo si el servicio dice su precio exacto: si no, la promoción delataría un número que la clínica no quiere dar.
          item.serviceDisclosure === "exacto"
          ? `${item.serviceName}: ${amount} en vez de ${tariff}${item.tariffCents > item.priceCents ? ` (ahorra ${formatOrgMoney(item.tariffCents - item.priceCents, item.currency, zone)})` : ""}`
          : `${item.serviceName}: ${amount} con la promoción (no compares con otro precio: el del servicio se define en la evaluación)`
    })
    .join("; ")
  return `- Promoción «${promo.name}»: ${items}.${promo.conditions ? ` Condiciones: ${promo.conditions}.` : ""}${until}`
}

export function formatBranchHours(item: AgentBranchHours, zone: Zone): string {
  const days = item.week.length
    ? item.week.map((day) => `${WEEKDAY_NAMES[day.weekday]} ${day.ranges.map(([a, b]) => `${clock(a)}–${clock(b)}`).join(" y ")}`).join("; ")
    : "sin horario cargado (no afirmes días ni horas)"
  const closed = item.closures.length
    ? ` Cerrada: ${item.closures
        .map((c) => {
          const from = new Date(c.startsAt).toLocaleString(zone.locale, { timeZone: zone.timezone, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })
          const to = new Date(c.endsAt).toLocaleString(zone.locale, { timeZone: zone.timezone, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })
          return `${from} a ${to}${c.reason ? ` (${c.reason})` : ""}`
        })
        .join("; ")}.`
    : ""
  return `- ${item.name}: ${days}.${closed}`
}

export function formatProfessional(item: AgentProfessionalInfo): string {
  const specialties = item.specialties.length ? ` (${item.specialties.join(", ")})` : ""
  const where = item.where
    .map((place) => `${place.branchName}: ${place.weekdays.map((day) => WEEKDAY_NAMES[day]).join(", ")}`)
    .join("; ")
  return `- ${item.name}${specialties}. ${where}. [profesional ${item.ref}: solo para pedir sus horas; no lo escribas]`
}

/* ---------- Buscar en la clínica ---------- */

export interface ClinicSearchResult {
  services: AgentServiceInfo[]
  promotions: AgentPromotionInfo[]
  professionals: AgentProfessionalInfo[]
  /** Lo que también coincidía y no cupo en la respuesta, por tipo: nunca un corte mudo. */
  more: { services: number; promotions: number; professionals: number }
}

/** Palabras de la pregunta que cuentan: sin las muy cortas ni las de relleno. */
const FILLER = new Set(["que", "para", "por", "con", "una", "uno", "los", "las", "del", "tienen", "tiene", "hay", "cuanto", "cuesta", "precio", "quiero", "necesito", "hacen", "como", "esta", "este", "mas"])

function tokensOf(text: string): string[] {
  return [...new Set(normalizeForSearch(text).split(" "))].filter((word) => word.length >= 3 && !FILLER.has(word))
}

/** Coincidencia por palabras: cuántas palabras de la pregunta aparecen (también como inicio de palabra). */
export function textScore(query: string, haystack: string): number {
  const words = tokensOf(query)
  if (!words.length) return 0
  const hay = ` ${normalizeForSearch(haystack)} `
  let score = 0
  for (const word of words) {
    if (hay.includes(` ${word} `)) score += 2
    else if (hay.includes(` ${word.slice(0, Math.max(4, word.length - 2))}`)) score += 1
  }
  return score
}

/**
 * Busca en lo que la clínica ofrece: servicios, promociones vigentes y
 * profesionales. `rank` permite poner delante lo que ya se encontró por
 * significado (búsqueda con vectores); lo que se devuelve siempre se lee de la
 * base en este momento.
 */
export async function searchClinic(
  tx: Db,
  orgId: string,
  query: string,
  options: { limit?: number; rankedServiceIds?: string[]; rankedPromotionIds?: string[]; rankedProfessionalIds?: string[] } = {},
): Promise<ClinicSearchResult> {
  const limit = Math.min(Math.max(options.limit ?? CLINIC_SEARCH_LIMIT, 1), 10)
  const services = await listAgentServices(tx, orgId)
  const promotions = await listAgentPromotions(tx, orgId)
  const professionals = await listAgentProfessionals(tx, orgId)

  const order = (ranked: string[] | undefined) => new Map((ranked ?? []).map((id, index) => [id, index]))
  const serviceRank = order(options.rankedServiceIds)
  const promoRank = order(options.rankedPromotionIds)
  const more = { services: 0, promotions: 0, professionals: 0 }
  const pick = <T>(
    items: T[],
    idOf: (item: T) => string,
    textOf: (item: T) => string,
    ranked: Map<string, number>,
    kind: keyof typeof more,
  ): T[] => {
    const matched = items
      .map((item) => {
        const position = ranked.get(idOf(item))
        // Lo encontrado por significado va primero, en su orden; después, lo que coincide por palabras.
        const score = (position === undefined ? 0 : 100 - position) + textScore(query, textOf(item))
        return { item, score }
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
    more[kind] = Math.max(0, matched.length - limit)
    return matched.slice(0, limit).map((entry) => entry.item)
  }

  const matchedServices = pick(services, (s) => s.id, (s) => `${s.name} ${s.specialty ?? ""}`, serviceRank, "services")
  const matchedNames = new Set(matchedServices.map((s) => normalizeForSearch(s.name)))
  const matchedPromotions = pick(
    promotions,
    (p) => p.id,
    (p) => `${p.name} ${p.conditions ?? ""} ${p.items.map((item) => item.serviceName).join(" ")}`,
    promoRank,
    "promotions",
  )
  // Una promoción de un servicio encontrado también viene, aunque su nombre no coincida.
  for (const promo of promotions) {
    if (matchedPromotions.length >= limit) break
    if (matchedPromotions.includes(promo)) continue
    if (promo.items.some((item) => matchedNames.has(normalizeForSearch(item.serviceName)))) matchedPromotions.push(promo)
  }
  const matchedProfessionals = pick(
    professionals,
    (p) => p.id,
    (p) => `${p.name} ${p.specialties.join(" ")}`,
    order(options.rankedProfessionalIds),
    "professionals",
  )
  return { services: matchedServices, promotions: matchedPromotions, professionals: matchedProfessionals, more }
}

/**
 * El servicio concreto por el que pregunta la persona, si lo hay: el que
 * coincide con más palabras completas de su nombre, sin empate. Solo por
 * palabras, a propósito: lo más parecido por significado siempre existe
 * («cirugía de nariz» queda cerca de alguna cirugía) y no basta para decir
 * que preguntó por ese servicio. Con empate («prótesis total» casa con la
 * superior y con la inferior) no hay uno: nulo.
 */
export function identifyAskedService(query: string, services: AgentServiceInfo[]): AgentServiceInfo | null {
  let best: AgentServiceInfo | null = null
  let bestScore = 0
  let tied = false
  for (const service of services) {
    const score = textScore(query, service.name)
    if (score > bestScore) {
      best = service
      bestScore = score
      tied = false
    } else if (score === bestScore && score > 0) {
      tied = true
    }
  }
  // Al menos una palabra completa del nombre: un prefijo suelto no identifica.
  return best && bestScore >= 2 && !tied ? best : null
}

/** Texto del resultado de una búsqueda para el modelo. */
export function formatClinicSearch(result: ClinicSearchResult, zone: Zone): string {
  const lines: string[] = []
  if (result.services.length) {
    lines.push("Servicios:")
    for (const service of result.services) lines.push(formatAgentService(service, zone))
  }
  if (result.promotions.length) {
    lines.push(`Promociones vigentes. ${PROMOTION_RULE}`)
    for (const promo of result.promotions) lines.push(formatAgentPromotion(promo, zone))
  }
  if (result.professionals.length) {
    lines.push("Profesionales:")
    for (const item of result.professionals) lines.push(formatProfessional(item))
  }
  // Lo encontrado por significado es lo más parecido, no lo pedido: medido en
  // eval:search, algo que la clínica no ofrece (cirugía de nariz) queda a la
  // misma distancia que una pregunta válida. Lo decide el modelo, con esta regla.
  const left = [
    result.more.services ? `${result.more.services} ${result.more.services === 1 ? "servicio" : "servicios"}` : null,
    result.more.promotions ? `${result.more.promotions} ${result.more.promotions === 1 ? "promoción" : "promociones"}` : null,
    result.more.professionals
      ? `${result.more.professionals} ${result.more.professionals === 1 ? "profesional" : "profesionales"}`
      : null,
  ].filter((item): item is string => item !== null)
  if (lines.length && left.length) {
    const said = left.length > 1 ? `${left.slice(0, -1).join(", ")} y ${left[left.length - 1]}` : left[0]
    lines.push(
      `Y ${said} más que también coinciden y no van aquí: no digas que estos son todos; si la persona busca otro, vuelve a buscar con palabras más precisas.`,
    )
  }
  return lines.length
    ? [
        "Lo más parecido en la clínica a lo que se busca. Si nada de esto es lo que pide la persona, dile que la clínica no lo ofrece; no presentes otro servicio como si fuera lo pedido.",
        ...lines,
      ].join("\n")
    : "No encontré nada que coincida en servicios, promociones ni profesionales de la clínica. No inventes: dilo y ofrece pasar el caso a una persona."
}

/**
 * ¿Pregunta por el precio o por la disponibilidad? Es la regla simple de una
 * clínica sin modelo de decisión para anotar el interés (decisión 15 de la
 * fase 4), con las palabras con que se pregunta.
 */
const PRICE_OR_AVAILABILITY =
  /(?<!\p{L})(?:cu[aá]nto|precios?|cuestan?|costos?|coste|valen?|salen?|tarifas?|cobran|presupuestos?|cotiza\p{L}*|disponib\p{L}*|horarios?|turnos?|citas?|agendar|reservar|atienden|tienen|hacen|hay)(?!\p{L})/iu

export function asksPriceOrAvailability(text: string): boolean {
  return PRICE_OR_AVAILABILITY.test(text)
}

/** ¿La búsqueda no encontró nada? Entonces la pregunta queda en «Preguntas sin respuesta». */
export function clinicSearchFoundNothing(result: ClinicSearchResult): boolean {
  return !result.services.length && !result.promotions.length && !result.professionals.length
}

/* ---------- El bloque de la clínica en el prompt ---------- */

export interface AgentClinicData {
  hours: AgentBranchHours[]
  professionals: AgentProfessionalInfo[]
  /** Todos los servicios activos: los que caben van con su precio; si no, solo su nombre en el índice. */
  services: AgentServiceInfo[]
  promotions: AgentPromotionInfo[]
  /**
   * «Informar» encendido. Apagado, el agente no recibe precios, promociones ni
   * profesionales (ADR 0021); los servicios llegan solo para agendar, con su
   * nombre, id y duración.
   */
  informs: boolean
}

/** Cómo van los servicios en el bloque de la clínica: enteros, solo su índice o ninguno. */
export type AgentServicesShown = "lista" | "indice" | "ninguno"

export function agentServicesShown(data: Pick<AgentClinicData, "services">): AgentServicesShown {
  if (!data.services.length) return "ninguno"
  return data.services.length > SERVICES_IN_PROMPT ? "indice" : "lista"
}

/**
 * Lo que el bloque estable necesita. Con «Informar» apagado, los horarios y,
 * si agenda (`books`), los servicios sin precio; con las dos apagadas, solo
 * los horarios.
 */
export async function getAgentClinicData(tx: Db, orgId: string, informs: boolean, books = true): Promise<AgentClinicData> {
  const hours = await getBranchHours(tx, orgId)
  if (!informs) {
    return { hours, professionals: [], services: books ? await listAgentServices(tx, orgId) : [], promotions: [], informs }
  }
  return {
    hours,
    professionals: await listAgentProfessionals(tx, orgId),
    services: await listAgentServices(tx, orgId),
    promotions: await listAgentPromotions(tx, orgId),
    informs,
  }
}

/* ---------- Lo que toma de tus datos ---------- */

/**
 * Lo que el agente de recepción lee de los datos de la clínica, contado para
 * mostrarlo en Conocimiento (ADR 0119): las mismas fuentes que su prompt
 * (`getAgentClinicData`, `getClinicInfoSnapshot`), así la pantalla dice lo
 * que de verdad recibe. Nada se escribe dos veces: cada fila se edita donde
 * vive.
 */
export interface AgentDataSources {
  /** Horario de atención de cada sede (la suma de los horarios del equipo) y sus cierres de los próximos días. */
  hours: AgentBranchHours[]
  branches: { total: number; withAddress: number; withPhone: number }
  team: { professionals: number; specialties: number }
  /** `priced`: los que dicen su precio («exacto» o «desde»); `withDuration`: los que dicen cuánto duran. */
  services: { total: number; priced: number; withDuration: number }
  promotions: Array<{ name: string; endsAt: string | null }>
  paymentMethods: string[]
  /** La clínica registró su teléfono para urgencias (ADR 0084). */
  emergencyPhone: boolean
  /**
   * «Informar» encendido. Apagado, no le llegan precios, promociones,
   * profesionales ni medios de pago (ADR 0021): la pantalla lo dice en esas filas.
   */
  informs: boolean
}

export async function getAgentDataSources(tx: Db, orgId: string): Promise<AgentDataSources> {
  const cfg = await getAgentConfig(tx, orgId)
  const snapshot = await getClinicInfoSnapshot(tx, orgId)
  const professionals = await listAgentProfessionals(tx, orgId)
  const services = await listAgentServices(tx, orgId)
  const promotions = await listAgentPromotions(tx, orgId)
  return {
    hours: await getBranchHours(tx, orgId),
    branches: {
      total: snapshot.branches.length,
      withAddress: snapshot.branches.filter((branch) => Boolean(branch.address?.trim())).length,
      withPhone: snapshot.branches.filter((branch) => Boolean(branch.phone?.trim())).length,
    },
    team: {
      professionals: professionals.length,
      specialties: new Set(professionals.flatMap((item) => item.specialties)).size,
    },
    services: {
      total: services.length,
      priced: services.filter((item) => item.price.disclosure !== "evaluacion" && item.price.priceCents > 0).length,
      withDuration: services.filter((item) => item.durationMin !== null).length,
    },
    promotions: promotions.map((item) => ({ name: item.name, endsAt: item.endsAt })),
    paymentMethods: snapshot.paymentMethods.map((method) => method.name),
    emergencyPhone: Boolean(snapshot.emergencyPhone),
    informs: !cfg.disabledFunctions.includes("informar"),
  }
}

/**
 * Índice de una clínica grande: «Especialidad: servicio, servicio…», sin
 * precio ni id, para que el agente sepa qué hay y lo busque. Lo que no cabe
 * se cuenta.
 */
export function formatServiceIndex(services: AgentServiceInfo[]): string[] {
  const groups = new Map<string, string[]>()
  for (const service of services.slice(0, SERVICES_IN_INDEX)) {
    // El nombre que la clínica le da a su especialidad: el mismo que dice el profesional.
    const name = service.specialty ?? "Otros"
    const list = groups.get(name) ?? []
    list.push(service.name)
    groups.set(name, list)
  }
  const lines = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "es"))
    .map(([name, list]) => `- ${name}: ${list.join(", ")}.`)
  const left = services.length - SERVICES_IN_INDEX
  if (left > 0) lines.push(`- Y ${left} servicios más que no van en este índice: búscalos por su nombre.`)
  return lines
}

function formatServiceForBooking(service: AgentServiceInfo): string {
  return `- ${service.name} (id ${service.id})${service.durationMin ? `, ${service.durationMin} min` : ""}`
}

/**
 * Las líneas de la clínica para el prompt. Lo que cabe va entero; lo que no,
 * se anuncia con su cantidad y se pide a `buscar_en_la_clinica`. Cada línea
 * dice lo que de verdad llega: nunca «sin servicios» si existen.
 */
export function formatAgentClinicData(data: AgentClinicData, zone: Zone): string[] {
  const lines: string[] = []
  if (data.hours.length) {
    lines.push("Horario de atención de cada sede (sale de los horarios del equipo):")
    for (const item of data.hours) lines.push(formatBranchHours(item, zone))
  }
  const shown = agentServicesShown(data)
  if (!data.informs) {
    // Solo para agendar: con «Informar» apagado no se habla de precios ni de qué incluye cada servicio.
    if (shown === "lista") {
      lines.push("Servicios, solo para agendar (con su id y su duración; no hablas de sus precios):")
      for (const service of data.services) lines.push(formatServiceForBooking(service))
    } else if (shown === "indice") {
      lines.push(
        `Servicios: la clínica tiene ${data.services.length}; aquí va solo su índice, para agendar (no hablas de sus precios). Sin el id del servicio, buscar_huecos usa la duración de una cita regular.`,
      )
      lines.push(...formatServiceIndex(data.services))
    }
    return lines
  }
  if (shown === "indice") {
    lines.push(
      `Servicios: la clínica tiene ${data.services.length} y aquí va solo su índice por especialidad, sin precios ni ids. Antes de hablar de un servicio, de su precio o de su duración, búscalo con buscar_en_la_clinica: ahí están su id y cómo decir su precio. No digas que la clínica no hace algo sin haberlo buscado.`,
    )
    lines.push(...formatServiceIndex(data.services))
  } else if (shown === "lista") {
    lines.push("Servicios y cómo decir su precio (cada importe con su moneda):")
    for (const service of data.services) lines.push(formatAgentService(service, zone))
  } else {
    lines.push("Sin servicios publicados: no des precios, ofrece derivar.")
  }
  if (data.promotions.length > PROMOTIONS_IN_PROMPT) {
    lines.push(`Hay ${data.promotions.length} promociones vigentes: búscalas con buscar_en_la_clinica antes de mencionar una.`)
  } else if (data.promotions.length) {
    lines.push(`Promociones vigentes (solo estas; ninguna otra). ${PROMOTION_RULE}`)
    for (const promo of data.promotions) lines.push(formatAgentPromotion(promo, zone))
  }
  if (data.professionals.length > PROFESSIONALS_IN_PROMPT) {
    lines.push(
      `Profesionales: la clínica tiene ${data.professionals.length}; búscalos por nombre o especialidad con buscar_en_la_clinica.`,
    )
  } else if (data.professionals.length) {
    lines.push("Profesionales, sus especialidades y qué días atienden en cada sede:")
    for (const item of data.professionals) lines.push(formatProfessional(item))
  }
  return lines
}
