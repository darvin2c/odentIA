import { formatMoney } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { type AgentPrice, searchClinic } from "./agent-clinic-info.js"
import { findFreeGaps } from "./agent-operations.js"
import { getOrgLocale } from "./locale.js"
import type { PersonCan } from "./people.js"

/**
 * Horarios libres y precios de la lista para escribir en la respuesta: datos del
 * servidor en textos fijos, sin modelo, y siempre editables en la caja. Tocar un
 * horario no lo aparta (ADR 0126).
 */
export interface PanelSuggestions {
  professionalName: string | null
  slots: Array<{ startsAt: string; label: string }>
  prices: Array<{ name: string; text: string }>
  /** Preguntó un precio que no está en la lista: se dice en vez de dejar el hueco. */
  noPriceFor: string | null
}

const ASKS_PRICE = /\b(cu[aá]nto|precio|precios|cuesta|cuestan|costo|costos|valor|cobran|tarifa)\b/i
const SLOTS_SHOWN = 3
const SLOTS_DAYS = 7

/**
 * El precio en una frase para la persona, respetando cómo se dice cada uno: el
 * que se cotiza no dice monto; solo la evaluación que se ofrece, si tiene el suyo.
 */
export function priceSentence(name: string, price: AgentPrice, locale: string): string {
  const money = (cents: number, currency: string) => formatMoney(cents, currency, locale)
  if (price.disclosure === "exacto") return `${name} cuesta ${money(price.priceCents, price.currency)}.`
  if (price.disclosure === "desde") return `${name} cuesta desde ${money(price.priceCents, price.currency)}.`
  const evaluation = price.evaluation
  const evaluationCost =
    evaluation?.disclosure === "exacto"
      ? ` La evaluación cuesta ${money(evaluation.priceCents, evaluation.currency)}.`
      : evaluation?.disclosure === "desde"
        ? ` La evaluación cuesta desde ${money(evaluation.priceCents, evaluation.currency)}.`
        : ""
  return `El precio de ${name} se define en una evaluación.${evaluationCost}`
}

/** «Hoy 4:30 p. m.», «Mañana 9:00 a. m.» o «Lunes 9:00 a. m.», con la zona de la clínica. */
function slotLabel(iso: string, locale: string, timeZone: string, now: Date): string {
  const day = (date: Date) => date.toLocaleDateString("en-CA", { timeZone })
  const time = new Date(iso).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", timeZone })
  if (day(new Date(iso)) === day(now)) return `Hoy ${time}`
  if (day(new Date(iso)) === day(new Date(now.getTime() + 86_400_000))) return `Mañana ${time}`
  const weekday = new Date(iso).toLocaleDateString(locale, { weekday: "long", timeZone })
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${time}`
}

/** Dónde buscar horarios: con quien se atendió la última vez y, si no, la primera sede de la clínica. */
async function placeOf(tx: Db, orgId: string, patientId: string | null): Promise<{ branchId: string; professionalUserId: string | null } | null> {
  if (patientId) {
    const [last] = await tx.execute<{ branchId: string; professionalUserId: string }>(sql`
      select a.branch_id as "branchId", a.professional_user_id as "professionalUserId" from appointment a
      where a.organization_id = ${orgId} and a.patient_id = ${patientId} and not a.is_test and a.status = 'atendida'
      order by a.starts_at desc limit 1`)
    if (last) return last
  }
  const [branch] = await tx.execute<{ id: string }>(sql`
    select b.id from branch b where b.organization_id = ${orgId} and b.is_active order by b.created_at, b.id limit 1`)
  return branch ? { branchId: branch.id, professionalUserId: null } : null
}

export async function panelSuggestions(
  tx: Db,
  orgId: string,
  input: { patientId: string | null; question: string | null; kind: string | null; can: PersonCan },
): Promise<PanelSuggestions> {
  const { locale, timezone } = await getOrgLocale(tx, orgId)
  const question = input.question?.trim() ?? ""
  let prices: PanelSuggestions["prices"] = []
  let noPriceFor: string | null = null
  if (question && input.can("catalog.read") && (input.kind === "precio" || ASKS_PRICE.test(question))) {
    const { services } = await searchClinic(tx, orgId, question, { limit: 3 })
    prices = services.map((service) => ({ name: service.name, text: priceSentence(service.name, service.price, locale) }))
    if (prices.length === 0) noPriceFor = "Lo que pregunta no coincide con ningún precio de tu lista."
  }

  // Un pago o una duda clínica no se responden ofreciendo una hora.
  let slots: PanelSuggestions["slots"] = []
  let professionalName: string | null = null
  if (input.kind !== "pago" && input.kind !== "clinico" && input.can("appointments.read")) {
    const place = await placeOf(tx, orgId, input.patientId)
    if (place) {
      const now = new Date()
      const search = (professionalUserId: string | null) =>
        findFreeGaps(tx, orgId, {
          branchId: place.branchId,
          from: now.toISOString(),
          to: new Date(now.getTime() + SLOTS_DAYS * 86_400_000).toISOString(),
          ...(professionalUserId ? { professionalUserId } : {}),
        })
      // Si quien la atendió no tiene horarios esta semana, se ofrece a quien sí.
      let { gaps } = await search(place.professionalUserId)
      if (gaps.length === 0 && place.professionalUserId) gaps = (await search(null)).gaps
      const first = gaps[0]
      if (first) {
        professionalName = first.professionalName
        // El primero de cada día, con la misma persona: para elegir, no para leer la agenda.
        const days = new Set<string>()
        for (const gap of gaps) {
          if (gap.professionalUserId !== first.professionalUserId) continue
          const day = new Date(gap.startsAt).toLocaleDateString("en-CA", { timeZone: timezone })
          if (days.has(day)) continue
          days.add(day)
          slots.push({ startsAt: gap.startsAt, label: slotLabel(gap.startsAt, locale, timezone, now) })
          if (slots.length === SLOTS_SHOWN) break
        }
      }
    }
  }
  return { professionalName, slots, prices, noPriceFor }
}
