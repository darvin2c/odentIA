/**
 * Semilla manual de Reportes: dos años de historia de una clínica mediana en
 * dos sedes, para que cada cifra tenga tendencia, comparación con el año
 * anterior y mapas de días y horas. Son registros del pasado y se insertan
 * directo (la agenda no reserva hacia atrás ni fuera de horario); aquí no se
 * envía ningún mensaje ni se activa nada.
 *
 * Todo sale de un generador con semilla fija: dos corridas del mismo día dan los mismos
 * datos. La historia termina dos días antes de hoy, para no tocar la agenda
 * de demostración (ayer, hoy y mañana).
 */
import { randomUUID } from "node:crypto"
import type { MedicationEntry } from "@odentia/clinical"
import { findMedication, includedTaxCents, medicalLeaveEnd } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { scheduleBlock } from "@odentia/db/schema/availability"
import {
  encounter,
  diagnosisCatalog,
  encounterDiagnosis,
  encounterProcedure,
  orgCounter,
  patient,
  patientContact,
  patientResponsibility,
  patientCharge,
  prescription,
  prescriptionItem,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentBudgetOption,
  treatmentPlan,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { medicalLeave } from "@odentia/db/schema/clinical-forms"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { expense, expenseRecurring } from "@odentia/db/schema/finance"
import { and, eq, inArray, sql } from "drizzle-orm"
import { getOrgLocale } from "./locale.js"
import { chargeTaxOf, orgTaxes } from "./clinic-taxes.js"
import { addMonths, currentMonthIn, dayStart as localDayStart, monthStart, reportDayOf, type YearMonth } from "./report-periods.js"
import { insertSeedPayments, type SeedCharge, type SeedPayment } from "./seed-payments.js"

export interface ReportsSeedProfessional {
  userId: string
  /** Como firma al cerrar (la base lo exige). */
  signerName: string
  registration: string
  /** Sede y días que atiende (0 domingo … 6 sábado) y si solo por la tarde. */
  branchId: string
  weekdays: number[]
  afternoonOnly?: boolean
  /** Cuánto de su agenda se llena en un mes normal, de 0 a 1. */
  occupancy: number
  /** Cómo firma su título; sin él, «Cirujano dentista». */
  signerTitle?: string
  /**
   * La especialidad que atiende (el tipo de la biblioteca, `librarySpecialtyIds`):
   * solo le tocan los servicios sin especialidad o de la suya.
   */
  specialty?: string | null
  /** A quién atiende por su especialidad (pediatría, hasta los 17 años). */
  who?: ReportsSeedWho
}

/**
 * A quién se le da un servicio o a quién atiende una especialidad: la edad
 * cumplida el día de la cita y el sexo (ISO 5218, `F` o `M`). Vacío: a todos.
 */
export interface ReportsSeedWho {
  minAge?: number
  maxAge?: number
  sex?: "F" | "M"
}

/** Años cumplidos el día `at`, desde la fecha de nacimiento AAAA-MM-DD. */
export function ageOn(birthDate: string, at: Date): number {
  const [year, month, day] = birthDate.slice(0, 10).split("-").map(Number) as [number, number, number]
  const on = new Date(at)
  let age = on.getUTCFullYear() - year
  if (on.getUTCMonth() + 1 < month || (on.getUTCMonth() + 1 === month && on.getUTCDate() < day)) age -= 1
  return Math.max(0, age)
}

/** Si la persona puede recibir ese servicio ese día. Sin datos de la persona, no se sabe y vale. */
export function whoFits(who: ReportsSeedWho | undefined, person: { birthDate: string; sex: "F" | "M" } | null, at: Date): boolean {
  if (!who || !person) return true
  if (who.sex && person.sex !== who.sex) return false
  const age = ageOn(person.birthDate, at)
  if (who.minAge !== undefined && age < who.minAge) return false
  if (who.maxAge !== undefined && age > who.maxAge) return false
  return true
}

/** Un medicamento de una receta sembrada, como lo pide la receta (DCI, concentración y forma). */
export interface ReportsSeedMedication {
  genericName: string
  strength: string
  dosageForm: string
  dose: string
  /** Una vía de `ADMINISTRATION_ROUTES`. */
  route: string
  frequency: string
  duration: string
  quantity?: number
  instructions?: string
}

/** Lo que se escribe en una atención cerrada de la historia. */
export interface ReportsSeedNote {
  evolution: string
  /** Código de la lista de la clínica (con `ReportsSeedRecipe.diagnosisSystem`). */
  diagnosisCode?: string
  vitals?: Record<string, unknown>
  examination?: Record<string, unknown>
  /**
   * La receta que se emitió en la atención: queda en Documentos y se imprime.
   * `weightKg`: el peso con que se recetó, que la receta de un menor de 12 años lleva.
   */
  prescription?: { items: readonly ReportsSeedMedication[]; notes?: string; weightKg?: number }
  /** El descanso médico que se emitió, desde el día de la atención. */
  leave?: { days: number; notes: string }
}

/** Una persona nueva: de qué edad y sexo, y si es menor, quién la trae. */
export interface ReportsSeedPerson {
  birthDate: string
  sex: "F" | "M"
  guardian?: { givenNames: string; familyName: string; kinship: "MTH" | "FTH" }
}

/**
 * Cómo es la clínica de la historia (demos para presentar, ADR 0096). Sin
 * receta rige la de Dental Smile: dos años, Perú, odontología y presupuestos.
 */
export interface ReportsSeedRecipe {
  months?: number
  seed?: number
  /** Mes-día sin atención (los del país). */
  holidays?: ReadonlySet<string>
  /** Qué parte de las visitas son de una persona nueva. */
  firstVisitShare?: number
  /** Quién es cada persona nueva (edad, sexo, responsable). */
  person?: (random: Random) => ReportsSeedPerson
  /** Lo que queda escrito en cada atención (`at`: cuándo empezó). */
  note?: (service: ReportsSeedInput["services"][number], random: Random, person: ReportsSeedPerson | null, at: Date) => ReportsSeedNote
  diagnosisSystem?: string
  /** El primer mensaje de quien escribe y la respuesta: `reply[i]` contesta a `inbound[i]`. */
  inbound?: readonly string[]
  reply?: readonly string[]
  budgets?: boolean
  paymentMethods?: ReadonlyArray<{ name: string; typeCode: string; weight: number }>
  /** Los gastos de cada mes y sede: el alquiler de la sede, un monto (más uno por profesional) o una parte de lo cobrado. */
  expenses?: ReadonlyArray<{ category: string; concept: string; rent?: boolean; cents?: number; perStaffCents?: number; revenueShare?: number; day: number }>
  names?: { given: readonly string[]; surnames: readonly string[]; bySex?: { F: readonly string[]; M: readonly string[] } }
  /** Promociones que ya existen: una parte de los cobros de su servicio en sus fechas lleva su precio. */
  promotions?: readonly ReportsSeedPromotion[]
  /** La lista de medicamentos del producto: el código ATC de lo que se receta sale de ella. */
  medications?: readonly MedicationEntry[]
}

/** Una promoción de la clínica sobre un servicio, como la aplica Caja al cobrar. */
export interface ReportsSeedPromotion {
  id: string
  name: string
  serviceId: string
  startsAt: Date
  endsAt: Date | null
  /** Qué parte de los cobros de su servicio la llevan. */
  share: number
  /** Lo acordado: el precio fijo o, con «desde», uno entre el mínimo y la tarifa. */
  priceCents: (random: Random) => number
}

/**
 * La promoción que lleva el cobro de un servicio terminado a esa hora, si le
 * toca: el concepto queda con su precio, su nombre y el motivo, como lo deja
 * «Aplicar promoción» en Caja. Sin promociones no usa el generador.
 */
export function promotionFor(
  promotions: readonly ReportsSeedPromotion[] | undefined,
  serviceId: string,
  at: Date,
  random: Random,
): { cents: number; charge: { promotionId: string; promotionName: string; editReason: string } } | null {
  const live = promotions?.find(
    (item) => item.serviceId === serviceId && item.startsAt <= at && (!item.endsAt || at < item.endsAt),
  )
  if (!live || !random.chance(live.share)) return null
  return {
    cents: live.priceCents(random),
    charge: { promotionId: live.id, promotionName: live.name, editReason: `Promoción «${live.name}»` },
  }
}

export interface ReportsSeedInput {
  orgId: string
  ownerUserId: string
  /** Sedes con historia, cada una con sus unidades dentales. */
  branches: Array<{ id: string; roomIds: string[]; rent: number }>
  professionals: ReportsSeedProfessional[]
  /**
   * Servicios del tarifario que se atienden, con su precio y duración. `specialty`:
   * solo lo da quien la atiende; `who`: a quién se le da; `perUnit`: se cobra por
   * unidad (una resina por pieza), y a veces van dos o tres en la misma atención.
   */
  services: Array<{
    id: string
    name: string
    priceCents: number
    durationMin: number
    weight: number
    firstVisit?: boolean
    specialty?: string
    who?: ReportsSeedWho
    perUnit?: boolean
  }>
  /** Pacientes que ya existían: vuelven en la historia. */
  patientIds: string[]
  recipe?: ReportsSeedRecipe
}

/** Meses de historia hacia atrás: dos años, para comparar cada mes con el mismo del año anterior. */
const MONTHS_BACK = 24
/** Horas de atención: de 9 a 13 y de 14 a 18 (las del horario de demostración). */
const MORNING = [9, 10, 11, 12]
const AFTERNOON = [14, 15, 16, 17]
/** Feriados de Perú (mes-día): sin citas y con la sede bloqueada. */
const HOLIDAYS = new Set(["01-01", "05-01", "06-29", "07-28", "07-29", "08-30", "10-08", "11-01", "12-08", "12-25"])
/** Verano y fiestas bajan la agenda; marzo y abril la suben. */
const SEASON: Record<number, number> = { 1: 0.82, 2: 0.8, 3: 1.06, 4: 1.04, 7: 0.94, 12: 0.84 }

const GIVEN = [
  "María", "José", "Lucía", "Carlos", "Ana", "Luis", "Rosa", "Jorge", "Carmen", "Miguel",
  "Sofía", "Diego", "Valeria", "Andrés", "Camila", "Fernando", "Gabriela", "Ricardo", "Daniela", "Javier",
  "Paola", "Raúl", "Patricia", "Óscar", "Mariana", "Víctor", "Natalia", "Hugo", "Claudia", "Martín",
  "Alejandra", "Renzo", "Fiorella", "César", "Milagros", "Iván", "Silvia", "Gonzalo", "Lorena", "Pedro",
]
const SURNAMES = [
  "García", "Rodríguez", "Flores", "Quispe", "Mamani", "Sánchez", "Ramírez", "Torres", "Castillo", "Mendoza",
  "Vargas", "Rojas", "Chávez", "Gutiérrez", "Huamán", "Díaz", "Ruiz", "Paredes", "Salazar", "Cruz",
  "Morales", "Ortiz", "Navarro", "Reyes", "Silva", "Delgado", "Campos", "Vega", "Ríos", "Aguilar",
  "Medina", "Herrera", "Castro", "León", "Espinoza", "Cáceres", "Valdivia", "Zapata", "Benites", "Palacios",
]
const PAYMENT_METHODS = [
  { method: "billetera", name: "Yape", typeCode: "68", weight: 34 },
  { method: "efectivo", name: "Efectivo", typeCode: "10", weight: 30 },
  { method: "tarjeta", name: "Tarjeta", typeCode: "48", weight: 26 },
  { method: "transferencia", name: "Transferencia", typeCode: "30", weight: 10 },
]

/** Generador determinista (mulberry32): la misma semilla da la misma historia. */
export function generator(seed: number) {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    chance: (p: number): boolean => next() < p,
    int: (min: number, max: number): number => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    weighted: <T extends { weight: number }>(items: readonly T[]): T => {
      const total = items.reduce((sum, item) => sum + item.weight, 0)
      let roll = next() * total
      for (const item of items) {
        roll -= item.weight
        if (roll < 0) return item
      }
      return items[items.length - 1] as T
    },
  }
}

/** Los códigos que la base tiene en su lista: un código que falta no se escribe (la clave foránea lo rechazaría). */
export async function knownDiagnosisCodes(tx: Db, system: string | undefined, codes: Array<string | undefined>): Promise<Set<string>> {
  const wanted = [...new Set(codes.filter((code): code is string => Boolean(code)))]
  if (!system || wanted.length === 0) return new Set()
  const rows = await tx
    .select({ code: diagnosisCatalog.code })
    .from(diagnosisCatalog)
    .where(and(eq(diagnosisCatalog.systemKey, system), inArray(diagnosisCatalog.code, wanted)))
  return new Set(rows.map((row) => row.code))
}

/** Una atención cerrada con lo que se emitió en ella: su receta y su descanso. */
export interface SeedPaperRow {
  patientId: string
  encounterId: string
  endedAt: Date
  note: ReportsSeedNote | null
  /** El diagnóstico de la atención, si la lista lo tiene: la receta lo lleva. */
  diagnosisCode: string | null
  signer: { userId: string; name: string; title: string | null; registration: string | null }
}

/**
 * Las recetas y los descansos médicos de atenciones ya firmadas, numerados por
 * clínica como los emite la app y firmados por quien atendió. Se insertan
 * directo porque son del pasado (la app receta con la atención en borrador);
 * su PDF se arma la primera vez que se abre (ADR 0132). El descanso no lleva el
 * diagnóstico: la persona no autorizó que figure.
 */
export async function insertSeedPapers(
  tx: Db,
  input: { orgId: string; timezone: string; diagnosisSystem: string | undefined; medications: readonly MedicationEntry[]; rows: readonly SeedPaperRow[] },
): Promise<void> {
  const prescribed = input.rows.filter((row) => (row.note?.prescription?.items.length ?? 0) > 0)
  const rested = input.rows.filter((row) => row.note?.leave)
  const numbers = async (key: string, count: number): Promise<number> => {
    const [counter] = await tx
      .insert(orgCounter)
      .values({ organizationId: input.orgId, key, value: count })
      .onConflictDoUpdate({ target: [orgCounter.organizationId, orgCounter.key], set: { value: sql`"org_counter"."value" + ${count}` } })
      .returning({ value: orgCounter.value })
    return (counter?.value ?? count) - count + 1
  }
  if (prescribed.length > 0) {
    const first = await numbers("prescription", prescribed.length)
    const rows = prescribed.map((row, index) => ({ row, id: randomUUID(), number: first + index }))
    await tx.insert(prescription).values(
      rows.map(({ row, id, number }) => ({
        id,
        organizationId: input.orgId,
        patientId: row.patientId,
        encounterId: row.encounterId,
        prescriptionNumber: number,
        notes: row.note?.prescription?.notes ?? null,
        ...(row.diagnosisCode && input.diagnosisSystem ? { diagnosisSystem: input.diagnosisSystem, diagnosisCode: row.diagnosisCode } : {}),
        patientWeightKg: row.note?.prescription?.weightKg !== undefined ? String(row.note.prescription.weightKg) : null,
        prescriberName: row.signer.name,
        prescriberTitle: row.signer.title,
        prescriberRegistration: row.signer.registration,
        issuedBy: row.signer.userId,
        issuedAt: row.endedAt,
        createdAt: row.endedAt,
        updatedAt: row.endedAt,
      })),
    )
    await tx.insert(prescriptionItem).values(
      rows.flatMap(({ row, id }) =>
        (row.note?.prescription?.items ?? []).map((item) => ({
          organizationId: input.orgId,
          patientId: row.patientId,
          prescriptionId: id,
          medicationName: `${item.genericName} ${item.strength} ${item.dosageForm}`,
          genericName: item.genericName,
          strength: item.strength,
          dosageForm: item.dosageForm,
          atcCode: findMedication(item.genericName, input.medications)?.atc ?? null,
          dose: item.dose,
          route: item.route,
          frequency: item.frequency,
          duration: item.duration,
          quantity: item.quantity ?? null,
          instructions: item.instructions ?? null,
          createdAt: row.endedAt,
        })),
      ),
    )
  }
  if (rested.length > 0) {
    const first = await numbers("medical_leave", rested.length)
    await tx.insert(medicalLeave).values(
      rested.map((row, index) => {
        const startsOn = reportDayOf(input.timezone, row.endedAt)
        const days = row.note?.leave?.days ?? 1
        return {
          organizationId: input.orgId,
          patientId: row.patientId,
          encounterId: row.encounterId,
          leaveNumber: first + index,
          startsOn,
          days,
          endsOn: medicalLeaveEnd(startsOn, days),
          showDiagnosis: false,
          notes: row.note?.leave?.notes ?? null,
          signerName: row.signer.name,
          signerTitle: row.signer.title,
          signerRegistration: row.signer.registration,
          issuedBy: row.signer.userId,
          issuedAt: row.endedAt,
          createdAt: row.endedAt,
          updatedAt: row.endedAt,
        }
      }),
    )
  }
}

export function chunks<T>(items: T[], size = 500): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

function localDay(date: Date, timezone: string): { weekday: number; monthDay: string; month: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "2-digit", day: "2-digit" }).formatToParts(date)
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? ""
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"))
  return { weekday, monthDay: `${get("month")}-${get("day")}`, month: Number(get("month")) }
}

interface PlannedVisit {
  id: string
  patientIndex: number
  professional: ReportsSeedProfessional
  branchId: string
  roomId: string
  service: ReportsSeedInput["services"][number]
  startsAt: Date
  status: "atendida" | "no_asistio" | "cancelada"
  source: "recepcion" | "agent" | "enlace"
  waitMinutes: number
  quantity: number
}

export async function seedReports(tx: Db, input: ReportsSeedInput): Promise<{ patients: number; appointments: number; conversations: number; budgets: number }> {
  const { timezone, currency } = await getOrgLocale(tx, input.orgId)
  const recipe = input.recipe ?? {}
  const monthsBack = recipe.months ?? MONTHS_BACK
  const holidaySet = recipe.holidays ?? HOLIDAYS
  const given = recipe.names?.given ?? GIVEN
  const surnames = recipe.names?.surnames ?? SURNAMES
  const random = generator(recipe.seed ?? 20_261_018)
  const current = currentMonthIn(timezone)
  const historyEnd = Date.now() - 2 * 86_400_000
  const first = addMonths(current, -monthsBack)
  const firstStart = monthStart(timezone, first.year, first.month).getTime()
  const totalDays = Math.floor((historyEnd - firstStart) / 86_400_000)

  // --- Pacientes nuevos: cada uno llega por su primera visita ------------------------------
  type NewPatient = { given: string; paternal: string; maternal: string; person: ReportsSeedPerson | null }
  const fresh: NewPatient[] = []
  // Quien tiene una atención en borrador no entra en la historia: la base admite
  // un solo borrador por persona y aquí cada atención nace como borrador.
  const drafts = new Set(
    (
      await tx
        .select({ patientId: encounter.patientId })
        .from(encounter)
        .where(and(eq(encounter.organizationId, input.orgId), eq(encounter.status, "borrador")))
    ).map((row) => row.patientId),
  )
  const pool: number[] = input.patientIds.flatMap((id, index) => (drafts.has(id) ? [] : [index]))
  const patientCount = (): number => input.patientIds.length + fresh.length
  const personOf = (index: number): ReportsSeedPerson | null =>
    index >= input.patientIds.length ? (fresh[index - input.patientIds.length]?.person ?? null) : null
  const newPatient = (person: ReportsSeedPerson | null): number => {
    const bySex = person ? recipe.names?.bySex?.[person.sex] : undefined
    fresh.push({
      given: random.pick(bySex ?? given),
      paternal: random.pick(surnames),
      maternal: random.pick(surnames),
      person,
    })
    const index = patientCount() - 1
    pool.push(index)
    return index
  }
  // Nadie viene antes de nacer, y cada servicio y cada especialidad atiende a quien le toca.
  const fits = (need: ReadonlyArray<ReportsSeedWho | undefined>, person: ReportsSeedPerson | null, at: Date): boolean =>
    !person || (person.birthDate <= at.toISOString().slice(0, 10) && need.every((who) => whoFits(who, person, at)))
  const newPatientFor = (need: ReadonlyArray<ReportsSeedWho | undefined>, at: Date): number | null => {
    if (!recipe.person) return newPatient(null)
    for (let tries = 0; tries < 40; tries += 1) {
      const person = recipe.person(random)
      if (fits(need, person, at)) return newPatient(person)
    }
    return null
  }
  const returningFor = (need: ReadonlyArray<ReportsSeedWho | undefined>, at: Date): number | null => {
    for (let tries = 0; tries < 12; tries += 1) {
      const index = pool[Math.max(0, pool.length - 1 - Math.floor(random.next() ** 2 * pool.length))] as number
      if (fits(need, personOf(index), at)) return index
    }
    return null
  }

  // --- La agenda día por día ---------------------------------------------------------------
  const visits: PlannedVisit[] = []
  const holidays: Array<{ branchId: string; day: Date }> = []
  // Lo que atiende cada profesional: los servicios sin especialidad y los de la suya.
  const offer = input.professionals.map((professional) => {
    const mine = input.services.filter(
      (service) => !service.specialty || !professional.specialty || service.specialty === professional.specialty,
    )
    return { first: mine.filter((service) => service.firstVisit), followUp: mine.filter((service) => !service.firstVisit) }
  })
  for (let day = 0; day < totalDays; day += 1) {
    const dayStart = new Date(firstStart + day * 86_400_000)
    const { weekday, monthDay, month } = localDay(new Date(dayStart.getTime() + 12 * 3_600_000), timezone)
    if (weekday === 0) continue
    if (holidaySet.has(monthDay)) {
      for (const branch of input.branches) holidays.push({ branchId: branch.id, day: dayStart })
      continue
    }
    // La clínica crece: hace dos años llenaba un 25 % menos.
    const growth = 0.75 + 0.25 * (day / totalDays)
    const season = SEASON[month] ?? 1
    for (const [professionalIndex, professional] of input.professionals.entries()) {
      if (!professional.weekdays.includes(weekday)) continue
      const branch = input.branches.find((item) => item.id === professional.branchId)
      if (!branch) continue
      const hours = professional.afternoonOnly ? AFTERNOON : weekday === 6 ? MORNING : [...MORNING, ...AFTERNOON]
      for (const hour of hours) {
        // De 3 a 6 de la tarde la agenda se llena menos: ahí quedan las horas libres.
        const afternoonDip = hour >= 15 && hour < 18 ? 0.72 : 1
        if (!random.chance(Math.min(0.97, professional.occupancy * growth * season * afternoonDip))) continue
        const startsAt = new Date(dayStart.getTime() + hour * 3_600_000 + random.pick([0, 0, 15]) * 60_000)
        // La primera visita es una evaluación de una persona nueva.
        const isFirst = random.chance(recipe.firstVisitShare ?? 0.11)
        const mine = offer[professionalIndex] as { first: typeof input.services; followUp: typeof input.services }
        const choices = isFirst && mine.first.length > 0 ? mine.first : mine.followUp.length > 0 ? mine.followUp : mine.first
        if (choices.length === 0) continue
        const service = random.weighted(choices)
        const need = [professional.who, service.who]
        const patientIndex =
          isFirst || pool.length < 30 ? newPatientFor(need, startsAt) : (returningFor(need, startsAt) ?? newPatientFor(need, startsAt))
        if (patientIndex === null) continue
        const roll = random.next()
        const status = roll < 0.07 ? "no_asistio" : roll < 0.16 ? "cancelada" : "atendida"
        // El agente agenda cada vez más: del 8 % al 34 % en dos años; el enlace, un 6 %.
        const sourceRoll = random.next()
        const agentShare = 0.08 + 0.26 * (day / totalDays)
        const source = sourceRoll < agentShare ? "agent" : sourceRoll < agentShare + 0.06 ? "enlace" : "recepcion"
        visits.push({
          id: randomUUID(),
          patientIndex,
          professional,
          branchId: branch.id,
          roomId: branch.roomIds[professionalIndex % branch.roomIds.length] as string,
          service,
          startsAt,
          status,
          source,
          waitMinutes: random.int(2, 18),
          // Solo lo que se cobra por unidad va de a dos o tres (resinas, radiografías); una consulta es una.
          quantity: service.perUnit && random.chance(0.12) ? random.int(2, 3) : 1,
        })
      }
    }
  }

  // --- Personas y fichas -------------------------------------------------------------------
  const [counter] = await tx
    .insert(orgCounter)
    .values({ organizationId: input.orgId, key: "patient", value: fresh.length })
    .onConflictDoUpdate({ target: [orgCounter.organizationId, orgCounter.key], set: { value: sql`"org_counter"."value" + ${fresh.length}` } })
    .returning({ value: orgCounter.value })
  const firstNumber = (counter?.value ?? fresh.length) - fresh.length + 1
  const patientIds = [...input.patientIds]
  const personIds: Array<string | null> = input.patientIds.map(() => null)
  // Quien escribe por cada paciente: él mismo o, si es menor, su responsable.
  const writerIds: Array<string | null> = input.patientIds.map(() => null)
  for (const [batchIndex, batch] of chunks(fresh).entries()) {
    const people = await tx
      .insert(contact)
      .values(
        batch.map((person) => ({
          organizationId: input.orgId,
          givenNames: person.given,
          // Los apellidos van juntos en un campo (ADR 0058).
          familyName: `${person.paternal} ${person.maternal}`,
          displayName: `${person.given} ${person.paternal} ${person.maternal}`,
          ...(person.person ? { birthDate: person.person.birthDate, sex: person.person.sex } : {}),
        })),
      )
      .returning({ id: contact.id })
    // El responsable es otra persona: el paciente no se confunde con quien lo trae.
    const guarded = batch.flatMap((person, index) => (person.person?.guardian ? [{ index, guardian: person.person.guardian }] : []))
    const guardianRows =
      guarded.length > 0
        ? await tx
            .insert(contact)
            .values(
              guarded.map(({ guardian }) => ({
                organizationId: input.orgId,
                givenNames: guardian.givenNames,
                familyName: guardian.familyName,
                displayName: `${guardian.givenNames} ${guardian.familyName}`,
                sex: guardian.kinship === "MTH" ? ("F" as const) : ("M" as const),
              })),
            )
            .returning({ id: contact.id })
        : []
    const guardianOf = new Map(guarded.map((item, position) => [item.index, { contactId: (guardianRows[position] as { id: string }).id, kinship: item.guardian.kinship }]))
    const rows = await tx
      .insert(patient)
      .values(
        people.map((person, index) => ({
          organizationId: input.orgId,
          personId: person.id,
          patientNumber: firstNumber + batchIndex * 500 + index,
        })),
      )
      .returning({ id: patient.id, personId: patient.personId })
    const links = rows.flatMap((row, index) => {
      const guardian = guardianOf.get(index)
      return guardian ? [{ patientId: row.id, ...guardian }] : []
    })
    if (links.length > 0) {
      // Con quien se habla es el responsable: deja de serlo el propio menor.
      await tx
        .update(patientContact)
        .set({ isPreferred: false })
        .where(and(eq(patientContact.organizationId, input.orgId), inArray(patientContact.patientId, links.map((link) => link.patientId))))
      await tx.insert(patientContact).values(
        links.map((link) => ({
          organizationId: input.orgId,
          patientId: link.patientId,
          contactId: link.contactId,
          relationship: "guardian" as const,
          kinship: link.kinship,
          isPreferred: true,
          createdBy: input.ownerUserId,
        })),
      )
      await tx.insert(patientResponsibility).values(
        links.map((link) => ({
          organizationId: input.orgId,
          patientId: link.patientId,
          contactId: link.contactId,
          kind: "representante_legal" as const,
          startsAt: new Date(firstStart).toISOString().slice(0, 10),
          createdBy: input.ownerUserId,
        })),
      )
    }
    for (const [index, row] of rows.entries()) {
      patientIds.push(row.id)
      personIds.push(row.personId)
      writerIds.push(guardianOf.get(index)?.contactId ?? row.personId)
    }
  }
  const patientOf = (index: number): string => patientIds[index] as string

  // --- Conversaciones: cómo llegó cada persona nueva y las consultas que no reservaron ------
  const connections = await tx
    .select({ id: channelConnection.id })
    .from(channelConnection)
    .where(eq(channelConnection.organizationId, input.orgId))
  const firstVisitOf = new Map<number, PlannedVisit>()
  for (const visit of visits) if (!firstVisitOf.has(visit.patientIndex) && visit.patientIndex >= input.patientIds.length) firstVisitOf.set(visit.patientIndex, visit)
  type Thread = { personIndex: number | null; inboundAt: Date; reply: { by: "agent" | "user"; seconds: number } | null }
  const threads: Thread[] = []
  const replyFor = (at: number): Thread["reply"] => {
    // El agente responde cada vez más y en minutos; el equipo tarda más; a veces nadie.
    const agentShare = 0.45 + 0.4 * ((at - firstStart) / (historyEnd - firstStart))
    const roll = random.next()
    if (roll < 0.05) return null
    return roll < 0.05 + agentShare ? { by: "agent", seconds: random.int(20, 150) } : { by: "user", seconds: random.int(240, 3_600) }
  }
  for (const [personIndex, visit] of firstVisitOf) {
    // Dos de cada tres personas nuevas escribieron antes de su primera visita.
    if (!random.chance(0.66)) continue
    const inboundAt = new Date(visit.startsAt.getTime() - random.int(1, 9) * 86_400_000 - random.int(1, 10) * 3_600_000)
    if (inboundAt.getTime() < firstStart) continue
    threads.push({ personIndex, inboundAt, reply: replyFor(inboundAt.getTime()) })
  }
  // Quien preguntó y no llegó a reservar: persona sin ficha.
  const inquiries: Thread[] = []
  for (let day = 0; day < totalDays; day += 1) {
    const at = firstStart + day * 86_400_000
    const count = random.chance(0.6) ? random.int(1, 3) : 0
    for (let index = 0; index < count; index += 1) {
      const inboundAt = new Date(at + random.int(8, 22) * 3_600_000 + random.int(0, 59) * 60_000)
      inquiries.push({ personIndex: null, inboundAt, reply: replyFor(inboundAt.getTime()) })
    }
  }
  const inquiryPeople: Array<{ id: string }> = []
  for (const batch of chunks(inquiries)) {
    inquiryPeople.push(
      ...(await tx
        .insert(contact)
        .values(
          batch.map(() => {
            const name = random.pick(given)
            const paternal = random.pick(surnames)
            return { organizationId: input.orgId, givenNames: name, familyName: paternal, displayName: `${name} ${paternal}` }
          }),
        )
        .returning({ id: contact.id })),
    )
  }
  const conversationOf = new Map<number, string>()
  const allThreads = [...threads, ...inquiries]
  let inquiryCursor = 0
  if (connections.length > 0) {
    const threadRows = allThreads.map((thread, index) => {
      const contactId = thread.personIndex === null ? (inquiryPeople[inquiryCursor++]?.id as string) : (writerIds[thread.personIndex] as string)
      const sentAt = thread.reply ? new Date(thread.inboundAt.getTime() + thread.reply.seconds * 1000) : null
      return {
        thread,
        sentAt,
        row: {
          id: randomUUID(),
          organizationId: input.orgId,
          contactId,
          channelConnectionId: (connections[index % connections.length] as { id: string }).id,
          externalThreadId: `seed-reportes-${index}`,
          status: "closed",
          // Las fechas del hilo son las de sus mensajes: la Bandeja ordena por ellas.
          createdAt: thread.inboundAt,
          attentionStartedAt: thread.inboundAt,
          lastInboundAt: thread.inboundAt,
          lastMessageAt: sentAt ?? thread.inboundAt,
          ...(sentAt ? { lastOutboundAt: sentAt } : {}),
          // Una cerrada dice cuándo, por qué y quién (ADR 0024).
          closedAt: new Date((sentAt ?? thread.inboundAt).getTime() + 3_600_000),
          closeReason: thread.reply ? ("resuelta" as const) : ("sin_respuesta" as const),
          ...(thread.reply?.by === "user" ? { closedByUserId: input.ownerUserId } : {}),
        },
      }
    })
    for (const batch of chunks(threadRows)) {
      await tx.insert(conversation).values(batch.map((item) => item.row))
      // Las corridas de las respuestas de Sofi las deja `seedRepliesRuns`, después del gasto de ejemplo.
      await tx.insert(message).values(
        batch.flatMap(({ thread, sentAt, row }) => {
          // La respuesta contesta a lo que preguntó: van de a pares en la receta.
          const exchange = recipe.inbound && recipe.inbound.length > 0 ? random.int(0, recipe.inbound.length - 1) : -1
          return [
            {
              organizationId: input.orgId,
              conversationId: row.id,
              direction: "in",
              senderKind: "contact",
              status: "received",
              body: exchange >= 0 ? (recipe.inbound?.[exchange] as string) : "Hola, quisiera una cita",
              createdAt: thread.inboundAt,
            },
            ...(thread.reply && sentAt
              ? [
                  {
                    organizationId: input.orgId,
                    conversationId: row.id,
                    direction: "out",
                    senderKind: thread.reply.by,
                    status: "sent",
                    body: recipe.reply?.[exchange] ?? (recipe.reply ? random.pick(recipe.reply) : "Con gusto, ¿qué día le acomoda?"),
                    externalId: `seed-reportes-${row.externalThreadId}`,
                    createdAt: sentAt,
                    sentAt,
                  },
                ]
              : []),
          ]
        }),
      )
      for (const { thread, row } of batch) if (thread.personIndex !== null) conversationOf.set(thread.personIndex, row.id)
    }
  }

  // --- Citas, llegadas y atenciones cerradas -----------------------------------------------
  const insertAppointments = async (list: PlannedVisit[]): Promise<void> => {
    for (const batch of chunks(list)) {
      await tx.insert(appointment).values(
        batch.map((visit) => {
          const endsAt = new Date(visit.startsAt.getTime() + visit.service.durationMin * 60_000)
          const attended = visit.status === "atendida"
          return {
            id: visit.id,
            organizationId: input.orgId,
            branchId: visit.branchId,
            roomId: visit.roomId,
            patientId: patientOf(visit.patientIndex),
            professionalUserId: visit.professional.userId,
            serviceId: visit.service.id,
            serviceName: visit.service.name,
            startsAt: visit.startsAt,
            endsAt,
            durationMin: visit.service.durationMin,
            status: visit.status,
            source: visit.source,
            // Lo que agendó el agente o el enlace sale de la conversación de la persona.
            conversationId: visit.source === "recepcion" ? null : (conversationOf.get(visit.patientIndex) ?? null),
            ...(attended ? { arrivedAt: new Date(visit.startsAt.getTime() - random.int(0, 10) * 60_000), arrivedBy: input.ownerUserId } : {}),
            createdAt: new Date(visit.startsAt.getTime() - random.int(1, 14) * 86_400_000),
          }
        }),
      )
    }
  }
  await insertAppointments(visits)
  // Una atención por cita atendida. La base admite un solo borrador por persona:
  // se cierran por rondas, la primera visita de cada persona, luego la segunda…
  const attended = visits.filter((visit) => visit.status === "atendida")
  const rounds: PlannedVisit[][] = []
  const seen = new Map<number, number>()
  for (const visit of attended) {
    const round = seen.get(visit.patientIndex) ?? 0
    seen.set(visit.patientIndex, round + 1)
    const list = rounds[round] ?? []
    list.push(visit)
    rounds[round] = list
  }
  const done: Array<{ visit: PlannedVisit; encounterId: string; procedureId: string; endedAt: Date; planItemId: string | null }> = []
  // Lo aceptado de cada presupuesto, por persona: la visita que lo hace lleva su
  // tratamiento, como cuando se atiende en la app. Sin esto el plan decía
  // «Realizado · 0 de 1 sesión · sin cargos» con el ticket de esa endodoncia
  // en Cobros (QA del 6 nov, D5).
  let budgets = 0
  const acceptedOf = new Map<string, Array<{ planItemId: string; serviceId: string; decidedAt: Date }>>()
  const carriedBy = (visit: PlannedVisit, startedAt: Date): string | null => {
    const lines = acceptedOf.get(patientOf(visit.patientIndex)) ?? []
    const index = lines.findIndex((line) => line.serviceId === visit.service.id && line.decidedAt.getTime() < startedAt.getTime())
    if (index < 0) return null
    const [line] = lines.splice(index, 1)
    return line?.planItemId ?? null
  }
  let budgetsSeeded = recipe.budgets === false
  const seedBudgetsOnce = async (): Promise<void> => {
    if (budgetsSeeded) return
    budgetsSeeded = true
    const seeded = await seedBudgets(tx, {
      orgId: input.orgId,
      currency,
      // Su propio generador: los presupuestos no mueven el azar de la agenda ni de los cobros.
      random: generator((recipe.seed ?? 20_261_018) + 1_093),
      historyEnd,
      services: input.services.filter((service) => !service.firstVisit),
      evaluations: done
        .filter((item) => item.visit.service.firstVisit && item.visit.patientIndex >= input.patientIds.length)
        .map((item) => ({ patientId: patientOf(item.visit.patientIndex), professionalUserId: item.visit.professional.userId, encounterId: item.encounterId, endedAt: item.endedAt })),
    })
    budgets = seeded.count
    for (const line of seeded.accepted) {
      const list = acceptedOf.get(line.patientId) ?? []
      list.push(line)
      acceptedOf.set(line.patientId, list)
    }
  }
  /** Las visitas que vienen a hacer un tratamiento aceptado (abajo): ya saben cuál. */
  const plannedItem = new Map<string, string>()
  const attendRound = async (round: PlannedVisit[]): Promise<void> => {
    for (const batch of chunks(round)) {
      const rows = batch.map((visit) => {
        // La llegada es anterior al inicio: la espera en sala queda medida.
        const startedAt = new Date(visit.startsAt.getTime() + Math.max(1, visit.waitMinutes - 5) * 60_000)
        const note = recipe.note ? recipe.note(visit.service, random, personOf(visit.patientIndex), startedAt) : null
        return {
          visit,
          note,
          id: randomUUID(),
          procedureId: randomUUID(),
          planItemId: plannedItem.get(visit.id) ?? carriedBy(visit, startedAt),
          startedAt,
          endedAt: new Date(startedAt.getTime() + visit.service.durationMin * 60_000),
        }
      })
      for (const row of rows)
        done.push({ visit: row.visit, encounterId: row.id, procedureId: row.procedureId, endedAt: row.endedAt, planItemId: row.planItemId })
      await tx.insert(encounter).values(
        rows.map((row) => ({
          id: row.id,
          organizationId: input.orgId,
          patientId: patientOf(row.visit.patientIndex),
          branchId: row.visit.branchId,
          professionalUserId: row.visit.professional.userId,
          appointmentId: row.visit.id,
          reason: row.visit.service.name,
          evolution: row.note?.evolution ?? "Procedimiento sin complicaciones.",
          ...(row.note?.vitals ? { vitals: row.note.vitals } : {}),
          ...(row.note?.examination ? { examination: row.note.examination } : {}),
          startedAt: row.startedAt,
          // Se abrió al empezar, como en la app: la Historia la fecha ese día y no el de la semilla.
          createdAt: row.startedAt,
          signerName: row.visit.professional.signerName,
          signerTitle: row.visit.professional.signerTitle ?? "Cirujano dentista",
          signerRegistration: row.visit.professional.registration,
        })),
      )
      const known = await knownDiagnosisCodes(tx, recipe.diagnosisSystem, rows.map((row) => row.note?.diagnosisCode))
      const diagnosed = rows.filter((row) => row.note?.diagnosisCode && known.has(row.note.diagnosisCode))
      if (diagnosed.length > 0) {
        await tx.insert(encounterDiagnosis).values(
          diagnosed.map((row) => ({
            organizationId: input.orgId,
            patientId: patientOf(row.visit.patientIndex),
            encounterId: row.id,
            diagnosisSystem: recipe.diagnosisSystem as string,
            diagnosisCode: row.note?.diagnosisCode as string,
            diagnosisType: "confirmed",
            status: "resuelto",
            resolvedAt: row.endedAt,
            createdBy: row.visit.professional.userId,
            createdAt: row.endedAt,
          })),
        )
      }
      await tx.insert(encounterProcedure).values(
        rows.map((row) => ({
          id: row.procedureId,
          organizationId: input.orgId,
          encounterId: row.id,
          serviceId: row.visit.service.id,
          planItemId: row.planItemId,
          description: row.visit.service.name,
          quantity: row.visit.quantity,
          priceCents: row.visit.service.priceCents,
          currency,
          createdBy: row.visit.professional.userId,
          createdAt: row.endedAt,
        })),
      )
      // Se cierran juntas: la firma ya está y el cierre es la hora de fin.
      await tx.execute(sql`
        update encounter e set status = 'finalizada', ended_at = v.ended_at, finalized_at = v.ended_at, finalized_by = e.professional_user_id
        from (values ${sql.join(
          rows.map((row) => sql`(${row.id}::uuid, ${row.endedAt.toISOString()}::timestamptz)`),
          sql`, `,
        )}) as v(id, ended_at)
        where e.organization_id = ${input.orgId} and e.id = v.id`)
      await insertSeedPapers(tx, {
        orgId: input.orgId,
        timezone,
        diagnosisSystem: recipe.diagnosisSystem,
        medications: recipe.medications ?? [],
        rows: rows.map((row) => ({
          patientId: patientOf(row.visit.patientIndex),
          encounterId: row.id,
          endedAt: row.endedAt,
          note: row.note,
          diagnosisCode: row.note?.diagnosisCode && known.has(row.note.diagnosisCode) ? row.note.diagnosisCode : null,
          signer: {
            userId: row.visit.professional.userId,
            name: row.visit.professional.signerName,
            title: row.visit.professional.signerTitle ?? null,
            registration: row.visit.professional.registration,
          },
        })),
      })
    }
  }
  for (const [roundIndex, round] of rounds.entries()) {
    // Los presupuestos nacen de las evaluaciones, que son la primera visita: después de la
    // primera ronda ya existen, y las visitas siguientes pueden hacer lo aceptado.
    if (roundIndex === 1) await seedBudgetsOnce()
    await attendRound(round)
  }
  await seedBudgetsOnce()

  // --- Lo aceptado hace tiempo se hizo -------------------------------------------------------
  // Una demo de ventas no muestra abandono masivo (revisión del 7 nov): de lo aceptado hace
  // más de dos meses que ninguna visita de la agenda hizo, cerca de uno de cada ocho se dejó
  // (el avance lo dice suspendido o cancelado) y el resto tuvo su visita, con su
  // procedimiento, su cargo y su cobro. Quien lo atiende da ese servicio a esa persona; la
  // visita va al cierre de su día, después de la agenda, para no pisar otra cita.
  const later = generator((recipe.seed ?? 20_261_018) + 2_026)
  const indexOf = new Map(patientIds.map((id, index) => [id, index] as const))
  const nextFree = new Map<string, number>()
  const extraVisits: PlannedVisit[] = []
  for (const [patientId, lines] of acceptedOf) {
    const patientIndex = indexOf.get(patientId)
    if (patientIndex === undefined) continue
    for (const line of lines) {
      if (line.decidedAt.getTime() >= historyEnd - 60 * 86_400_000) continue
      if (later.chance(0.12)) continue
      const service = input.services.find((item) => item.id === line.serviceId)
      if (!service) continue
      let placed: PlannedVisit | null = null
      for (let tries = 0; tries < 21 && !placed; tries += 1) {
        const day = new Date(line.decidedAt.getTime() + (later.int(3, 14) + tries) * 86_400_000)
        if (day.getTime() >= historyEnd) break
        const { weekday, monthDay } = localDay(new Date(day.getTime() + 12 * 3_600_000), timezone)
        if (weekday === 0 || holidaySet.has(monthDay)) continue
        const [year, month, date] = reportDayOf(timezone, day).split("-").map(Number) as [number, number, number]
        const evening = localDayStart(timezone, year, month, date).getTime() + 18 * 3_600_000
        for (const [professionalIndex, professional] of input.professionals.entries()) {
          if (!professional.weekdays.includes(weekday)) continue
          const mine = offer[professionalIndex]
          if (!mine?.followUp.some((item) => item.id === service.id)) continue
          const branch = input.branches.find((item) => item.id === professional.branchId)
          if (!branch) continue
          const roomId = branch.roomIds[professionalIndex % branch.roomIds.length] as string
          const keys = [`p:${professional.userId}:${evening}`, `r:${roomId}:${evening}`]
          const startsAt = new Date(Math.max(evening, ...keys.map((key) => nextFree.get(key) ?? evening)))
          if (startsAt.getTime() >= historyEnd || !fits([professional.who, service.who], personOf(patientIndex), startsAt)) continue
          const ends = startsAt.getTime() + service.durationMin * 60_000
          for (const key of keys) nextFree.set(key, ends)
          placed = {
            id: randomUUID(),
            patientIndex,
            professional,
            branchId: branch.id,
            roomId,
            service,
            startsAt,
            status: "atendida",
            source: "recepcion",
            waitMinutes: later.int(2, 12),
            quantity: 1,
          }
          break
        }
      }
      if (!placed) continue
      plannedItem.set(placed.id, line.planItemId)
      extraVisits.push(placed)
    }
  }
  if (extraVisits.length > 0) {
    extraVisits.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    await insertAppointments(extraVisits)
    visits.push(...extraVisits)
    // Un borrador por persona a la vez: por rondas, como la agenda.
    const extraRounds: PlannedVisit[][] = []
    const count = new Map<number, number>()
    for (const visit of extraVisits) {
      const round = count.get(visit.patientIndex) ?? 0
      count.set(visit.patientIndex, round + 1)
      const list = extraRounds[round] ?? []
      list.push(visit)
      extraRounds[round] = list
    }
    for (const round of extraRounds) await attendRound(round)
  }

  // --- Cargos y cobros ------------------------------------------------------------------------
  // Cada tratamiento atendido deja su cargo. Casi todo se paga ese día; algunos
  // pagan después, otros en dos partes y unos pocos siguen debiendo: de ahí
  // salen «Te deben hace más de 30 días» y lo cobrado por profesional.
  const charges: Array<typeof patientCharge.$inferInsert> = []
  const payments: SeedPayment[] = []
  const charged = new Map<string, SeedCharge>()
  // Como en Cobrar (ADR 0083): cada atención con el impuesto de su país y cada pago con el suyo.
  const tax = chargeTaxOf(await orgTaxes(tx, input.orgId), false)
  // La historia cobra hasta el día anterior a su último: ese día y los siguientes los cierra la agenda de la demo.
  const historyDay = reportDayOf(timezone, new Date(historyEnd))
  const [cutYear, cutMonth, cutDate] = historyDay.split("-").map(Number) as [number, number, number]
  const historyCut = localDayStart(timezone, cutYear, cutMonth, cutDate).getTime()
  const pay = (visit: PlannedVisit, chargeId: string, cents: number, paidAt: Date): void => {
    if (paidAt.getTime() >= historyCut || cents <= 0) return
    const method = random.weighted(recipe.paymentMethods ?? PAYMENT_METHODS)
    payments.push({
      patientId: patientOf(visit.patientIndex),
      branchId: visit.branchId,
      chargeId,
      amountCents: cents,
      taxCents: tax?.taxCategory === "S" ? includedTaxCents(cents, tax.taxBps) : 0,
      currency,
      paidAt,
      methodName: method.name,
      methodTypeCode: method.typeCode,
      createdBy: input.ownerUserId,
    })
  }
  for (const item of done) {
    const { visit } = item
    const promoted = promotionFor(recipe.promotions, visit.service.id, item.endedAt, random)
    const cents = (promoted?.cents ?? visit.service.priceCents) * visit.quantity
    const chargeId = randomUUID()
    charged.set(chargeId, {
      description: visit.service.name,
      amountCents: cents,
      promotionName: promoted?.charge.promotionName ?? null,
      taxCategory: tax?.taxCategory ?? null,
      taxBps: tax?.taxBps ?? null,
    })
    charges.push({
      id: chargeId,
      organizationId: input.orgId,
      patientId: patientOf(visit.patientIndex),
      encounterProcedureId: item.procedureId,
      // El cargo es del tratamiento que la visita hizo: el recorrido dice qué se pagó.
      planItemId: item.planItemId,
      branchId: visit.branchId,
      description: visit.service.name,
      amountCents: cents,
      currency,
      ...(tax ?? {}),
      ...(promoted?.charge ?? {}),
      createdBy: visit.professional.userId,
      createdAt: item.endedAt,
    })
    const sameDay = new Date(item.endedAt.getTime() + 5 * 60_000)
    const later = (min: number, max: number): Date => new Date(item.endedAt.getTime() + random.int(min, max) * 86_400_000)
    const roll = random.next()
    if (roll < 0.86) pay(visit, chargeId, cents, sameDay)
    else if (roll < 0.92) pay(visit, chargeId, cents, later(10, 70))
    else if (roll < 0.97) {
      const half = Math.round(cents / 2 / 100) * 100
      pay(visit, chargeId, half, sameDay)
      pay(visit, chargeId, cents - half, later(15, 60))
    }
    // El resto sigue debiéndose.
  }
  for (const batch of chunks(charges)) await tx.insert(patientCharge).values(batch)
  // Cada pago con su ticket y su caja: Reportes, Cobros y los cierres cuentan lo mismo.
  await insertSeedPayments(tx, {
    orgId: input.orgId,
    payments,
    charges: charged,
    openFrom: reportDayOf(timezone, new Date()),
    cashierUserId: input.ownerUserId,
  })

  // Los presupuestos (tres de cada cuatro evaluaciones de personas nuevas) nacen después
  // de la primera ronda de atenciones, arriba.

  // --- Gastos del mes, por sede -------------------------------------------------------------
  const income = new Map<string, number>()
  for (const payment of payments) {
    const key = `${payment.branchId}:${payment.paidAt.toISOString().slice(0, 7)}`
    income.set(key, (income.get(key) ?? 0) + payment.amountCents)
  }
  const expenses: Array<typeof expense.$inferInsert> = []
  // El alquiler, la planilla y los servicios se anotan como gastos que se repiten, con su historia
  // enlazada mes a mes: así la demo muestra «por pagar» solo lo que de verdad falta este mes.
  const REPEATING = new Set(["Planilla del mes", "Alquiler del local", "Luz, agua e internet"])
  const templates = new Map<string, typeof expenseRecurring.$inferInsert & { id: string }>()
  // Del mes en curso, solo lo que ya se pagó (hasta donde llega la historia).
  for (let back = monthsBack; back >= 0; back -= 1) {
    const month: YearMonth = addMonths(current, -back)
    const start = monthStart(timezone, month.year, month.month).getTime()
    for (const branch of input.branches) {
      const revenue = income.get(`${branch.id}:${new Date(start + 15 * 86_400_000).toISOString().slice(0, 7)}`) ?? 0
      const staffOf = input.professionals.filter((professional) => professional.branchId === branch.id)
      // El sueldo base de cada profesional va con su nombre (se ve junto a su comisión); la
      // planilla es la del resto del equipo.
      const salaries = (perStaffCents: number, day: number) =>
        perStaffCents > 0
          ? staffOf.map((professional) => ({
              category: "Personal",
              concept: `Sueldo base de ${professional.signerName}`,
              cents: perStaffCents,
              day,
              memberUserId: professional.userId,
            }))
          : []
      const monthly: Array<{ category: string; concept: string; cents: number; day: number; memberUserId?: string }> =
        recipe.expenses
          ? recipe.expenses.flatMap((item) => [
              {
                category: item.category,
                concept: item.concept,
                cents:
                  item.revenueShare !== undefined
                    ? Math.round((revenue * item.revenueShare) / 100) * 100
                    : item.rent
                      ? branch.rent
                      : (item.cents ?? 0),
                day: item.day,
              },
              ...salaries(item.perStaffCents ?? 0, item.day),
            ])
          : [
              { category: "Personal", concept: "Planilla del mes", cents: 3_000_00, day: 28 },
              ...salaries(900_00, 28),
              { category: "Alquiler", concept: "Alquiler del local", cents: branch.rent, day: 1 },
              { category: "Laboratorio", concept: "Coronas y prótesis", cents: Math.round((revenue * 0.09) / 100) * 100, day: 20 },
              { category: "Materiales", concept: "Insumos", cents: Math.round((revenue * 0.05) / 100) * 100, day: 12 },
              { category: "Servicios", concept: "Luz, agua e internet", cents: 650_00 + random.int(0, 30) * 1_000, day: 18 },
            ]
      for (const item of monthly) {
        const spentAt = new Date(start + (item.day - 1) * 86_400_000 + 15 * 3_600_000)
        // Lo que se repite se paga hasta hoy: cortarlo en la historia (dos días antes)
        // dejaría «vencido» lo del día 1, 18 o 28 recién sembrado.
        const repeats = REPEATING.has(item.concept) || item.memberUserId !== undefined
        const until = repeats ? Date.now() : historyEnd
        if (item.cents <= 0 || spentAt.getTime() > until) continue
        const month = spentAt.toISOString().slice(0, 7)
        let link: { recurringId: string; recurringMonth: string } | Record<string, never> = {}
        if (repeats) {
          const key = `${branch.id}|${item.concept}`
          const template = templates.get(key) ?? {
            id: randomUUID(),
            organizationId: input.orgId,
            branchId: branch.id,
            category: item.category,
            concept: item.concept,
            amountCents: item.cents,
            currency,
            everyMonths: 1,
            day: item.day,
            firstMonth: month,
            fromCash: false,
            memberUserId: item.memberUserId ?? null,
            createdBy: input.ownerUserId,
          }
          // Se propone el último importe pagado.
          template.amountCents = item.cents
          templates.set(key, template)
          link = { recurringId: template.id, recurringMonth: month }
        }
        expenses.push({
          organizationId: input.orgId,
          branchId: branch.id,
          concept: item.concept,
          category: item.category,
          amountCents: item.cents,
          currency,
          spentAt,
          createdBy: input.ownerUserId,
          ...link,
        })
      }
    }
  }
  if (templates.size > 0) await tx.insert(expenseRecurring).values([...templates.values()])
  for (const batch of chunks(expenses)) await tx.insert(expense).values(batch)

  // --- Feriados: la sede cerrada ese día ------------------------------------------------------
  for (const batch of chunks(holidays)) {
    await tx.insert(scheduleBlock).values(
      batch.map((holiday) => ({
        organizationId: input.orgId,
        branchId: holiday.branchId,
        professionalUserId: null,
        roomId: null,
        kind: "bloqueo",
        reason: "Feriado",
        startsAt: holiday.day,
        endsAt: new Date(holiday.day.getTime() + 86_400_000),
        createdBy: input.ownerUserId,
      })),
    )
  }

  return { patients: fresh.length, appointments: visits.length, conversations: connections.length > 0 ? allThreads.length : 0, budgets }
}

export type Random = ReturnType<typeof generator>

/**
 * Presupuestos presentados tras una evaluación, con su respuesta: aceptados,
 * aceptados en parte, rechazados o esperando. Se insertan en borrador (la base
 * solo deja agregar líneas así) y se entregan con su fecha. Uno de cada ocho
 * lleva un descuento sobre la tarifa. Solo personas nuevas: ninguna tiene otro
 * borrador.
 */
async function seedBudgets(
  tx: Db,
  input: {
    orgId: string
    currency: string
    random: Random
    historyEnd: number
    services: ReportsSeedInput["services"]
    evaluations: Array<{ patientId: string; professionalUserId: string; encounterId: string; endedAt: Date }>
  },
): Promise<{ count: number; accepted: Array<{ planItemId: string; patientId: string; serviceId: string; decidedAt: Date }> }> {
  const { random } = input
  const chosen = input.evaluations.filter(() => random.chance(0.75))
  if (chosen.length === 0) return { count: 0, accepted: [] }
  const [counter] = await tx
    .insert(orgCounter)
    .values({ organizationId: input.orgId, key: "budget", value: chosen.length })
    .onConflictDoUpdate({ target: [orgCounter.organizationId, orgCounter.key], set: { value: sql`"org_counter"."value" + ${chosen.length}` } })
    .returning({ value: orgCounter.value })
  const firstNumber = (counter?.value ?? chosen.length) - chosen.length + 1
  type Outcome = "aceptado" | "parcial" | "rechazado" | "presentado" | "pospuesto"
  const plans = chosen.map((evaluation, index) => {
    const presentedAt = new Date(evaluation.endedAt.getTime() + random.int(0, 2) * 86_400_000 + 3_600_000)
    const lineCount = random.int(1, 3)
    const services: ReportsSeedInput["services"] = []
    for (let tries = 0; services.length < lineCount && tries < 20; tries += 1) {
      const service = random.weighted(input.services)
      if (!services.some((item) => item.id === service.id)) services.push(service)
    }
    const discount = random.chance(0.125)
    const roll = random.next()
    let outcome: Outcome = roll < 0.55 ? "aceptado" : roll < 0.63 ? "parcial" : roll < 0.78 ? "rechazado" : roll < 0.9 ? "presentado" : "pospuesto"
    let decidedAt: Date | null =
      outcome === "presentado" ? null : new Date(presentedAt.getTime() + random.int(0, 14) * 86_400_000 + random.int(1, 8) * 3_600_000)
    // Lo que todavía no se decidió a hoy sigue esperando respuesta.
    if (decidedAt && decidedAt.getTime() > input.historyEnd) {
      outcome = "presentado"
      decidedAt = null
    }
    if (outcome === "parcial" && services.length < 2) outcome = "aceptado"
    const decisionOf = (position: number): string =>
      outcome === "aceptado"
        ? "aceptado"
        : outcome === "parcial"
          ? position === 0
            ? "aceptado"
            : "pospuesto"
          : outcome === "rechazado"
            ? "rechazado"
            : outcome === "pospuesto"
              ? "pospuesto"
              : "pendiente"
    return {
      evaluation,
      planId: randomUUID(),
      budgetId: randomUUID(),
      optionId: randomUUID(),
      number: firstNumber + index,
      presentedAt,
      outcome,
      decidedAt,
      lines: services.map((service, position) => ({
        planItemId: randomUUID(),
        itemId: randomUUID(),
        service,
        priceCents: discount ? Math.round((service.priceCents * 0.9) / 100) * 100 : service.priceCents,
        decision: decisionOf(position),
      })),
    }
  })
  const planItems = plans.flatMap((plan) => plan.lines.map((line) => ({ plan, line })))
  for (const batch of chunks(plans))
    await tx.insert(treatmentPlan).values(
      batch.map((plan) => ({
        id: plan.planId,
        organizationId: input.orgId,
        patientId: plan.evaluation.patientId,
        title: "Plan de tratamiento",
        originEncounterId: plan.evaluation.encounterId,
        createdBy: plan.evaluation.professionalUserId,
        createdAt: plan.evaluation.endedAt,
      })),
    )
  for (const batch of chunks(planItems))
    await tx.insert(treatmentPlanItem).values(
      batch.map(({ plan, line }) => ({
        id: line.planItemId,
        organizationId: input.orgId,
        patientId: plan.evaluation.patientId,
        planId: plan.planId,
        serviceId: line.service.id,
        title: line.service.name,
        priceCents: line.priceCents,
        currency: input.currency,
        decisionStatus: line.decision,
        sourceEncounterId: plan.evaluation.encounterId,
        createdBy: plan.evaluation.professionalUserId,
        createdAt: plan.evaluation.endedAt,
      })),
    )
  for (const batch of chunks(plans))
    await tx.insert(treatmentBudget).values(
      batch.map((plan) => ({
        id: plan.budgetId,
        organizationId: input.orgId,
        patientId: plan.evaluation.patientId,
        planId: plan.planId,
        budgetNumber: plan.number,
        title: "Plan de tratamiento",
        currency: input.currency,
        createdBy: plan.evaluation.professionalUserId,
        createdAt: plan.evaluation.endedAt,
      })),
    )
  for (const batch of chunks(plans))
    await tx.insert(treatmentBudgetOption).values(
      batch.map((plan) => ({
        id: plan.optionId,
        organizationId: input.orgId,
        patientId: plan.evaluation.patientId,
        budgetId: plan.budgetId,
        position: 1,
        isRecommended: true,
        decision: plan.outcome === "aceptado" || plan.outcome === "parcial" ? "elegida" : "pendiente",
        createdBy: plan.evaluation.professionalUserId,
      })),
    )
  for (const batch of chunks(planItems))
    await tx.insert(treatmentBudgetItem).values(
      batch.map(({ plan, line }) => ({
        id: line.itemId,
        organizationId: input.orgId,
        patientId: plan.evaluation.patientId,
        planId: plan.planId,
        budgetId: plan.budgetId,
        optionId: plan.optionId,
        planItemId: line.planItemId,
        serviceId: line.service.id,
        title: line.service.name,
        priceCents: line.priceCents,
        tariffPriceCents: line.service.priceCents,
        currency: input.currency,
        decision: line.decision,
        createdBy: plan.evaluation.professionalUserId,
      })),
    )
  // Cada tratamiento sabe en qué presupuesto está, como cuando lo arma la app:
  // sin esto, «¿Qué respondió?» falla con «La propuesta ya no es vigente».
  await tx.execute(sql`
    update treatment_plan_item i set budget_id = bi.budget_id
    from treatment_budget_item bi
    where bi.organization_id = ${input.orgId} and i.organization_id = ${input.orgId}
      and bi.plan_item_id = i.id and i.budget_id is null`)
  // Entregados con su fecha y su respuesta: desde aquí la base ya no deja tocar las líneas.
  for (const batch of chunks(plans))
    await tx.execute(sql`
      update treatment_budget t set status = v.status, presented_at = v.presented_at, decided_at = v.decided_at,
        decided_by = case when v.decided_at is null then null else t.created_by end
      from (values ${sql.join(
        batch.map(
          (plan) =>
            sql`(${plan.budgetId}::uuid, ${plan.outcome}::text, ${plan.presentedAt.toISOString()}::timestamptz, ${plan.decidedAt?.toISOString() ?? null}::timestamptz)`,
        ),
        sql`, `,
      )}) as v(id, status, presented_at, decided_at)
      where t.organization_id = ${input.orgId} and t.id = v.id`)
  const accepted = plans.flatMap((plan) =>
    plan.decidedAt && (plan.outcome === "aceptado" || plan.outcome === "parcial")
      ? plan.lines
          .filter((line) => line.decision === "aceptado")
          .map((line) => ({ planItemId: line.planItemId, patientId: plan.evaluation.patientId, serviceId: line.service.id, decidedAt: plan.decidedAt as Date }))
      : [],
  )
  return { count: plans.length, accepted }
}
