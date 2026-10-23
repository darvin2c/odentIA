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
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { scheduleBlock } from "@odentia/db/schema/availability"
import {
  encounter,
  encounterProcedure,
  orgCounter,
  patient,
  patientCharge,
  patientPayment,
  patientPaymentApplication,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentBudgetOption,
  treatmentPlan,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { expense } from "@odentia/db/schema/finance"
import { and, eq, sql } from "drizzle-orm"
import { getOrgLocale } from "./locale.js"
import { includedTaxCents } from "@odentia/clinical"
import { chargeTaxOf, orgTaxes } from "./clinic-taxes.js"
import { addMonths, currentMonthIn, monthStart, type YearMonth } from "./report-periods.js"

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
}

export interface ReportsSeedInput {
  orgId: string
  ownerUserId: string
  /** Sedes con historia, cada una con sus unidades dentales. */
  branches: Array<{ id: string; roomIds: string[]; rent: number }>
  professionals: ReportsSeedProfessional[]
  /** Servicios del tarifario que se atienden, con su precio y duración. */
  services: Array<{ id: string; name: string; priceCents: number; durationMin: number; weight: number; firstVisit?: boolean }>
  /** Pacientes que ya existían: vuelven en la historia. */
  patientIds: string[]
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
  const random = generator(20_261_018)
  const current = currentMonthIn(timezone)
  const historyEnd = Date.now() - 2 * 86_400_000
  const first = addMonths(current, -MONTHS_BACK)
  const firstStart = monthStart(timezone, first.year, first.month).getTime()
  const totalDays = Math.floor((historyEnd - firstStart) / 86_400_000)

  // --- Pacientes nuevos: cada uno llega por su primera visita ------------------------------
  type NewPatient = { given: string; paternal: string; maternal: string }
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
  const newPatient = (): number => {
    fresh.push({ given: random.pick(GIVEN), paternal: random.pick(SURNAMES), maternal: random.pick(SURNAMES) })
    const index = patientCount() - 1
    pool.push(index)
    return index
  }

  // --- La agenda día por día ---------------------------------------------------------------
  const visits: PlannedVisit[] = []
  const holidays: Array<{ branchId: string; day: Date }> = []
  const firstVisitServices = input.services.filter((service) => service.firstVisit)
  const followUpServices = input.services.filter((service) => !service.firstVisit)
  for (let day = 0; day < totalDays; day += 1) {
    const dayStart = new Date(firstStart + day * 86_400_000)
    const { weekday, monthDay, month } = localDay(new Date(dayStart.getTime() + 12 * 3_600_000), timezone)
    if (weekday === 0) continue
    if (HOLIDAYS.has(monthDay)) {
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
        // La primera visita es una evaluación de una persona nueva.
        const isFirst = random.chance(0.11)
        const patientIndex = isFirst || pool.length < 30 ? newPatient() : (pool[Math.max(0, pool.length - 1 - Math.floor(random.next() ** 2 * pool.length))] as number)
        const service = isFirst && firstVisitServices.length > 0 ? random.weighted(firstVisitServices) : random.weighted(followUpServices)
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
          startsAt: new Date(dayStart.getTime() + hour * 3_600_000 + random.pick([0, 0, 15]) * 60_000),
          status,
          source,
          waitMinutes: random.int(2, 18),
          quantity: service.priceCents < 20_000 && random.chance(0.12) ? random.int(2, 3) : 1,
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
        })),
      )
      .returning({ id: contact.id })
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
    for (const row of rows) {
      patientIds.push(row.id)
      personIds.push(row.personId)
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
            const given = random.pick(GIVEN)
            const paternal = random.pick(SURNAMES)
            return { organizationId: input.orgId, givenNames: given, familyName: paternal, displayName: `${given} ${paternal}` }
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
      const contactId = thread.personIndex === null ? (inquiryPeople[inquiryCursor++]?.id as string) : (personIds[thread.personIndex] as string)
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
      await tx.insert(message).values(
        batch.flatMap(({ thread, sentAt, row }) => [
          {
            organizationId: input.orgId,
            conversationId: row.id,
            direction: "in",
            senderKind: "contact",
            status: "received",
            body: "Hola, quisiera una cita",
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
                  body: "Con gusto, ¿qué día le acomoda?",
                  externalId: `seed-reportes-${row.externalThreadId}`,
                  createdAt: sentAt,
                  sentAt,
                },
              ]
            : []),
        ]),
      )
      for (const { thread, row } of batch) if (thread.personIndex !== null) conversationOf.set(thread.personIndex, row.id)
    }
  }

  // --- Citas, llegadas y atenciones cerradas -----------------------------------------------
  for (const batch of chunks(visits)) {
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
  const done: Array<{ visit: PlannedVisit; encounterId: string; procedureId: string; endedAt: Date }> = []
  for (const round of rounds) {
    for (const batch of chunks(round)) {
      const rows = batch.map((visit) => {
        // La llegada es anterior al inicio: la espera en sala queda medida.
        const startedAt = new Date(visit.startsAt.getTime() + Math.max(1, visit.waitMinutes - 5) * 60_000)
        return { visit, id: randomUUID(), procedureId: randomUUID(), startedAt, endedAt: new Date(startedAt.getTime() + visit.service.durationMin * 60_000) }
      })
      for (const row of rows) done.push({ visit: row.visit, encounterId: row.id, procedureId: row.procedureId, endedAt: row.endedAt })
      await tx.insert(encounter).values(
        rows.map((row) => ({
          id: row.id,
          organizationId: input.orgId,
          patientId: patientOf(row.visit.patientIndex),
          branchId: row.visit.branchId,
          professionalUserId: row.visit.professional.userId,
          appointmentId: row.visit.id,
          reason: row.visit.service.name,
          evolution: "Procedimiento sin complicaciones.",
          startedAt: row.startedAt,
          signerName: row.visit.professional.signerName,
          signerTitle: "Cirujano dentista",
          signerRegistration: row.visit.professional.registration,
        })),
      )
      await tx.insert(encounterProcedure).values(
        rows.map((row) => ({
          id: row.procedureId,
          organizationId: input.orgId,
          encounterId: row.id,
          serviceId: row.visit.service.id,
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
    }
  }

  // --- Cargos y cobros ------------------------------------------------------------------------
  // Cada tratamiento atendido deja su cargo. Casi todo se paga ese día; algunos
  // pagan después, otros en dos partes y unos pocos siguen debiendo: de ahí
  // salen «Te deben hace más de 30 días» y lo cobrado por profesional.
  const charges: Array<typeof patientCharge.$inferInsert> = []
  const payments: Array<typeof patientPayment.$inferInsert & { id: string; paidAt: Date; branchId: string }> = []
  const applications: Array<typeof patientPaymentApplication.$inferInsert> = []
  // Como en Cobrar (ADR 0083): cada atención con el impuesto de su país y cada pago con el suyo.
  const tax = chargeTaxOf(await orgTaxes(tx, input.orgId), false)
  const pay = (visit: PlannedVisit, chargeId: string, cents: number, paidAt: Date): void => {
    if (paidAt.getTime() > historyEnd || cents <= 0) return
    const method = random.weighted(PAYMENT_METHODS)
    const id = randomUUID()
    payments.push({
      id,
      organizationId: input.orgId,
      patientId: patientOf(visit.patientIndex),
      branchId: visit.branchId,
      amountCents: cents,
      taxCents: tax?.taxCategory === "S" ? includedTaxCents(cents, tax.taxBps) : 0,
      currency,
      paidAt,
      methodName: method.name,
      methodTypeCode: method.typeCode,
      createdBy: input.ownerUserId,
    })
    applications.push({ organizationId: input.orgId, patientId: patientOf(visit.patientIndex), paymentId: id, chargeId, amountCents: cents, createdBy: input.ownerUserId, createdAt: paidAt })
  }
  for (const item of done) {
    const { visit } = item
    const cents = visit.service.priceCents * visit.quantity
    const chargeId = randomUUID()
    charges.push({
      id: chargeId,
      organizationId: input.orgId,
      patientId: patientOf(visit.patientIndex),
      encounterProcedureId: item.procedureId,
      branchId: visit.branchId,
      description: visit.service.name,
      amountCents: cents,
      currency,
      ...(tax ?? {}),
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
  for (const batch of chunks(payments)) await tx.insert(patientPayment).values(batch)
  for (const batch of chunks(applications)) await tx.insert(patientPaymentApplication).values(batch)

  // --- Presupuestos: tres de cada cuatro evaluaciones de personas nuevas terminan en uno -----
  const budgets = await seedBudgets(tx, {
    orgId: input.orgId,
    currency,
    random,
    historyEnd,
    services: input.services.filter((service) => !service.firstVisit),
    evaluations: done
      .filter((item) => item.visit.service.firstVisit && item.visit.patientIndex >= input.patientIds.length)
      .map((item) => ({ patientId: patientOf(item.visit.patientIndex), professionalUserId: item.visit.professional.userId, encounterId: item.encounterId, endedAt: item.endedAt })),
  })

  // --- Gastos del mes, por sede -------------------------------------------------------------
  const income = new Map<string, number>()
  for (const payment of payments) {
    const key = `${payment.branchId}:${payment.paidAt.toISOString().slice(0, 7)}`
    income.set(key, (income.get(key) ?? 0) + payment.amountCents)
  }
  const expenses: Array<typeof expense.$inferInsert> = []
  // Del mes en curso, solo lo que ya se pagó (hasta donde llega la historia).
  for (let back = MONTHS_BACK; back >= 0; back -= 1) {
    const month: YearMonth = addMonths(current, -back)
    const start = monthStart(timezone, month.year, month.month).getTime()
    for (const branch of input.branches) {
      const revenue = income.get(`${branch.id}:${new Date(start + 15 * 86_400_000).toISOString().slice(0, 7)}`) ?? 0
      const staff = input.professionals.filter((professional) => professional.branchId === branch.id).length
      for (const item of [
        { category: "Personal", concept: "Planilla del mes", cents: 4_200_00 + staff * 2_100_00, day: 28 },
        { category: "Alquiler", concept: "Alquiler del local", cents: branch.rent, day: 1 },
        { category: "Laboratorio", concept: "Coronas y prótesis", cents: Math.round((revenue * 0.09) / 100) * 100, day: 20 },
        { category: "Materiales", concept: "Insumos", cents: Math.round((revenue * 0.06) / 100) * 100, day: 12 },
        { category: "Servicios", concept: "Luz, agua e internet", cents: 650_00 + random.int(0, 30) * 1_000, day: 18 },
      ]) {
        const spentAt = new Date(start + (item.day - 1) * 86_400_000 + 15 * 3_600_000)
        if (item.cents <= 0 || spentAt.getTime() > historyEnd) continue
        expenses.push({
          organizationId: input.orgId,
          branchId: branch.id,
          concept: item.concept,
          category: item.category,
          amountCents: item.cents,
          currency,
          spentAt,
          createdBy: input.ownerUserId,
        })
      }
    }
  }
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

type Random = ReturnType<typeof generator>

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
): Promise<number> {
  const { random } = input
  const chosen = input.evaluations.filter(() => random.chance(0.75))
  if (chosen.length === 0) return 0
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
  return plans.length
}
