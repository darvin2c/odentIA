import { randomUUID } from "node:crypto"
import { LEGAL } from "@odentia/auth/legal"
import type { ClinicalProduct } from "@odentia/clinical"
import { includedTaxCents } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import type { DemoProgress, DemoSize } from "@odentia/db/schema/admin-demos"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import { appointment } from "@odentia/db/schema/agenda"
import { member, organization, user } from "@odentia/db/schema/auth"
import {
  clinicalFollowUp,
  encounter,
  encounterDiagnosis,
  encounterProcedure,
  patientCharge,
  patientDocument,
  patientPayment,
  patientPaymentApplication,
  serviceCatalog,
  treatmentTemplate,
} from "@odentia/db/schema/clinical"
import { channelConnection, message } from "@odentia/db/schema/crm"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { processingAgreementAcceptance } from "@odentia/db/schema/workspace"
import { and, eq, gte, inArray, isNotNull, like, lt, sql } from "drizzle-orm"
import { createHandoff } from "./agent-operations.js"
import { upsertAgentConfig } from "./agentConfig.js"
import { createRoom } from "./appointments.js"
import { setProfessionalSchedule } from "./availability.js"
import { chargeTaxOf, orgTaxes } from "./clinic-taxes.js"
import { setProfessionalSpecialties } from "./clinical-forms.js"
import { createConnection } from "./connections.js"
import { DEMO_COUNTRIES, DEMO_SIZE_RECIPES, type DemoCountry, type DemoKindRecipe, demoPriceCents } from "./demo-recipes.js"
import { ServiceError } from "./errors.js"
import { getOrgLocale } from "./locale.js"
import { initialOrgRegion } from "./organization-profile.js"
import { ensureDefaultPaymentMethods } from "./payment-methods.js"
import { ensureDefaultPipeline } from "./pipelines.js"
import { demoKindsFor } from "./products.js"
import { setProfessionalProfile } from "./professional-profiles.js"
import { addDays, dayStart, reportDayOf } from "./report-periods.js"
import { defaultPlanOf } from "./saas-plan-product.js"
import { seedChannelTemplates } from "./seed-automation.js"
import { seedConversationIn, seedMessageIn } from "./seed-common.js"
import { chunks, generator, type Random, seedReports } from "./seed-reports.js"
import { seedReportsAgent } from "./seed-reports-agent.js"
import { seedReportsArgos } from "./seed-reports-argos.js"
import { seedReportsPatients } from "./seed-reports-patients.js"
import { seedSaasCostDemo } from "./seed-saas-cost.js"
import { fromTemplates } from "./service-catalog.js"
import { librarySpecialtyIds } from "./specialties.js"

/**
 * El motor de las demos para presentar (ADR 0096). Arma una clínica inventada
 * con la receta de su tipo: el equipo sin cuentas, su tarifario, meses de
 * historia (`seedReports` y las demás semillas de Reportes con la receta) y
 * las próximas dos semanas. Cada noche `advanceDemo` cierra los días que
 * pasaron y agrega los que entran, para que la agenda de hoy siempre tenga
 * algo que mostrar. Todo corre con la conexión owner del worker y en una sola
 * transacción: una demo nunca queda a medias. Nada sale a una persona: el
 * canal tiene claves falsas y los correos son de example.com.
 */

/** Días de agenda hacia adelante. */
const HORIZON_DAYS = 14
const MORNING = [9, 10, 11, 12]
const AFTERNOON = [14, 15, 16, 17]

export interface DemoRecipeRef {
  id: string
  product: ClinicalProduct
  kind: string
  size: DemoSize
  months: number
  countryCode: string
  name: string
  slug: string
  presenterUserId: string
  seed: number
}

export function demoKindOf(product: ClinicalProduct, key: string): DemoKindRecipe {
  const kind = demoKindsFor(product).find((item) => item.key === key)
  if (!kind) throw new ServiceError("VALIDATION", 400, "Ese tipo de demo no existe para el producto")
  return kind
}

export function demoCountryOf(code: string): DemoCountry {
  const country = DEMO_COUNTRIES[code as DemoCountry["code"]]
  if (!country) throw new ServiceError("VALIDATION", 400, "Las demos son de Perú, Colombia o México")
  return country
}

/** Las personas inventadas del equipo de una demo: su id dice de qué demo son. */
export const demoUserPrefix = (demoId: string): string => `demo-${demoId}-`

/** El nombre de una clínica de este tipo en un lugar del país: «Pediatría Los Olivos». */
export function demoClinicName(kind: DemoKindRecipe, country: DemoCountry, random: Random): string {
  return random.pick(kind.clinicNames).replace("{lugar}", random.pick(country.places))
}

interface TeamMember {
  userId: string
  name: string
  signerName: string
  registration: string
  title: string
  branchId: string
  weekdays: number[]
  afternoonOnly: boolean
  occupancy: number
}

interface AgendaContext {
  orgId: string
  timezone: string
  currency: string
  kind: DemoKindRecipe
  random: Random
  receptionUserId: string
  team: TeamMember[]
  rooms: Map<string, string[]>
  services: Array<{ id: string; name: string; priceCents: number; durationMin: number; weight: number; firstVisit: boolean }>
  paymentMethods: DemoCountry["paymentMethods"]
}

/**
 * Arma la demo entera dentro de `tx`. `onProgress` va fuera de la transacción
 * (lo escribe el worker con otra conexión): dice en qué paso va.
 */
export async function buildDemo(
  tx: Db,
  demo: DemoRecipeRef,
  deps: { secretsKey: Buffer; fetch: typeof fetch; onProgress?: (progress: DemoProgress) => Promise<void> | void },
): Promise<{ organizationId: string; historyThrough: string }> {
  const kind = demoKindOf(demo.product, demo.kind)
  const country = demoCountryOf(demo.countryCode)
  const size = DEMO_SIZE_RECIPES[demo.size]
  const random = generator(demo.seed)
  const TOTAL = 5
  const step = async (done: number, name: string) => deps.onProgress?.({ step: name, done, total: TOTAL })
  const now = new Date()
  await step(0, "equipo")

  // --- La clínica, del producto y país de la receta -----------------------------------------
  const orgId = randomUUID()
  const region = initialOrgRegion({ countryCode: country.code, timezone: country.timezone })
  await tx.insert(organization).values({ id: orgId, name: demo.name, slug: demo.slug, createdAt: now })
  await tx.insert(orgProfile).values({
    organizationId: orgId,
    product: demo.product,
    legalName: demo.name,
    tradeName: demo.name,
    countryCode: region.countryCode,
    currency: region.currency,
    timezone: region.timezone,
    locale: region.locale,
    // La CIE-11 oficial es la única lista completa de producción (decisión 8).
    diagnosisSystem: "ICD-11",
  })
  const [plan] = await tx.select({ id: saasPlan.id, code: saasPlan.code }).from(saasPlan).where(defaultPlanOf(demo.product)).limit(1)
  if (!plan) throw new ServiceError("CONFLICT", 409, "Falta el plan de lista del producto: créalo en «Cobros y planes»")
  // El disparador abrió la suscripción; la demo no se cobra y muestra el gasto con su plan.
  await tx.update(saasSubscription).set({ isDemo: true, planId: plan.id }).where(eq(saasSubscription.organizationId, orgId))

  // Quien presenta entra como propietario y la clínica aceptó el contrato de encargo por él.
  await tx.insert(member).values({ id: randomUUID(), organizationId: orgId, userId: demo.presenterUserId, role: "owner", createdAt: now })
  await tx.insert(processingAgreementAcceptance).values({ organizationId: orgId, version: LEGAL.agreement.version, acceptedBy: demo.presenterUserId })

  // --- Sedes, consultorios y el equipo sin cuentas --------------------------------------------
  const places = [...country.places].sort(() => random.next() - 0.5)
  const branches: Array<{ id: string; rent: number }> = []
  for (let index = 0; index < size.branches; index += 1) {
    const [row] = await tx
      .insert(branch)
      .values({ organizationId: orgId, name: `Sede ${places[index] ?? index + 1}`, country: country.code })
      .returning({ id: branch.id })
    branches.push({ id: (row as { id: string }).id, rent: demoPriceCents(index === 0 ? 5_500 : 4_200, country) })
  }
  const roomWord = demo.product === "dental" ? "Unidad" : "Consultorio"
  const rooms = new Map<string, string[]>()
  for (const item of branches) {
    const ids: string[] = []
    for (let index = 0; index < size.rooms; index += 1) ids.push((await createRoom(tx, orgId, { branchId: item.id, name: `${roomWord} ${index + 1}` })).id)
    rooms.set(item.id, ids)
  }

  const prefix = demoUserPrefix(demo.id)
  const terms = { termsVersion: LEGAL.terms.version, termsAcceptedAt: now }
  const people: Array<{ id: string; role: "clinician" | "reception" | "cashier"; sex: "F" | "M"; given: string; family: string }> = []
  for (let index = 0; index < size.professionals; index += 1) {
    const sex = random.chance(0.55) ? "F" : "M"
    people.push({ id: `${prefix}${index + 1}`, role: "clinician", sex, given: random.pick(country.given[sex]), family: random.pick(country.surnames) })
  }
  people.push({ id: `${prefix}recepcion`, role: "reception", sex: "F", given: random.pick(country.given.F), family: random.pick(country.surnames) })
  if (demo.size !== "pequeno") people.push({ id: `${prefix}caja`, role: "cashier", sex: "M", given: random.pick(country.given.M), family: random.pick(country.surnames) })
  await tx.insert(user).values(
    people.map((person, index) => {
      const honorific = person.role === "clinician" ? (person.sex === "F" ? "Dra. " : "Dr. ") : ""
      return {
        id: person.id,
        name: `${honorific}${person.given} ${person.family}`,
        firstName: person.given,
        lastName: person.family,
        email: `${person.role}${index + 1}.${demo.slug}@example.com`,
        emailVerified: true,
        ...terms,
      }
    }),
  )
  await tx.insert(member).values(people.map((person) => ({ id: randomUUID(), organizationId: orgId, userId: person.id, role: person.role, createdAt: now })))
  const receptionUserId = `${prefix}recepcion`

  const team: TeamMember[] = []
  for (const [index, person] of people.filter((item) => item.role === "clinician").entries()) {
    const branchId = (branches[index % branches.length] as { id: string }).id
    // En las grandes, uno de cada cuatro atiende solo martes y jueves por la tarde.
    const afternoonOnly = demo.size === "grande" && index % 4 === 3
    const weekdays = afternoonOnly ? [2, 4] : [1, 2, 3, 4, 5, 6]
    const registration = String(random.int(10_000, 99_999))
    const title = kind.professional.title[person.sex]
    const signerName = `${person.given} ${person.family}`
    await setProfessionalProfile(tx, orgId, demo.presenterUserId, person.id, {
      professionalTitle: title,
      registrationBody: country.registration[demo.product],
      registrationNumber: registration,
      signatureName: signerName,
    })
    await setProfessionalSchedule(tx, orgId, demo.presenterUserId, {
      branchId,
      professionalUserId: person.id,
      rules: weekdays.flatMap((weekday) =>
        afternoonOnly
          ? [{ weekday, startMin: 14 * 60, endMin: 18 * 60 }]
          : weekday === 6
            ? [{ weekday, startMin: 9 * 60, endMin: 13 * 60 }]
            : [
                { weekday, startMin: 9 * 60, endMin: 13 * 60 },
                { weekday, startMin: 14 * 60, endMin: 18 * 60 },
              ],
      ),
    })
    const specialtyKind = kind.specialtyRotation?.[index] ?? kind.professional.specialty
    if (specialtyKind) {
      const ids = await librarySpecialtyIds(tx, orgId, [specialtyKind])
      const id = ids.get(specialtyKind)
      if (id) await setProfessionalSpecialties(tx, orgId, demo.presenterUserId, person.id, [id])
    }
    team.push({
      userId: person.id,
      name: `${person.sex === "F" ? "Dra." : "Dr."} ${signerName}`,
      signerName,
      registration,
      title,
      branchId,
      weekdays,
      afternoonOnly,
      occupancy: Math.min(0.92, kind.occupancy + (random.next() - 0.5) * 0.12),
    })
  }

  await ensureDefaultPaymentMethods(tx, orgId, demo.presenterUserId, country.code)
  await ensureDefaultPipeline(tx, orgId)
  await upsertAgentConfig(
    tx,
    orgId,
    {
      enabled: true,
      clinicalAssistantEnabled: true,
      personaName: "Sofi",
      treatment: "usted",
      tone: "cercano",
      about: `${kind.name} en ${places[0] ?? country.name}, ${country.name}. Atendemos con cita y respondemos por WhatsApp todos los días.`,
    },
    { actorUserId: demo.presenterUserId },
  )

  // El canal de la demo tiene claves falsas: nada de lo que se escriba desde ella sale.
  const phone = `${country.mobile.prefix}${String(random.int(10 ** (country.mobile.digits - 1), 10 ** country.mobile.digits - 1))}`
  const connection = await createConnection(
    tx,
    orgId,
    deps.secretsKey,
    {
      channel: "whatsapp",
      provider: "whatsapp_cloud_api",
      displayName: `WhatsApp ${demo.name}`,
      config: { phoneNumberId: `demo-${demo.id}`, wabaId: `demo-waba-${demo.id}`, displayPhoneNumber: phone, accessToken: "demo", appSecret: "demo" },
    },
    { fetch: deps.fetch, validateExternal: false },
  )
  await tx
    .update(channelConnection)
    .set({
      webhookVerifiedAt: new Date(now.getTime() - 7 * 86_400_000),
      health: { quality: "alta", dailyLimit: 2000, unlimited: false, number: phone, name: demo.name, checkedAt: now.toISOString() },
    })
    .where(eq(channelConnection.id, connection.id))
  await seedChannelTemplates(tx, { orgId, connectionId: connection.id })

  // --- El tarifario de la receta, desde la biblioteca del producto ----------------------------
  await step(1, "tarifario")
  const templates = await tx
    .select({ id: treatmentTemplate.id, key: treatmentTemplate.key })
    .from(treatmentTemplate)
    .where(and(eq(treatmentTemplate.product, demo.product), inArray(treatmentTemplate.key, kind.services.map((item) => item.template))))
  const templateIdOf = new Map(templates.map((row) => [row.key, row.id]))
  for (const recipe of kind.services) {
    const templateId = templateIdOf.get(recipe.template)
    if (!templateId) continue
    // Una prestación que el país no codifica no se ofrece: se salta sin deshacer las demás.
    await tx
      .transaction((inner) => fromTemplates(inner, orgId, demo.presenterUserId, [{ templateId, priceCents: demoPriceCents(recipe.price, country), durationMin: recipe.durationMin }]))
      .catch(() => undefined)
  }
  const services = await demoServices(tx, orgId, kind)
  if (!services.some((item) => item.firstVisit)) throw new ServiceError("CONFLICT", 409, "Falta la biblioteca del producto: ejecuta seed:procedures")

  // --- La historia de los meses que se pidieron -----------------------------------------------
  await step(2, "historia")
  await seedReports(tx, {
    orgId,
    ownerUserId: receptionUserId,
    branches: branches.map((item) => ({ id: item.id, roomIds: rooms.get(item.id) ?? [], rent: item.rent })),
    professionals: team.map((item) => ({
      userId: item.userId,
      signerName: item.signerName,
      registration: item.registration,
      branchId: item.branchId,
      weekdays: item.weekdays,
      afternoonOnly: item.afternoonOnly,
      occupancy: item.occupancy,
      signerTitle: item.title,
    })),
    services,
    patientIds: [],
    recipe: {
      months: demo.months,
      seed: demo.seed,
      holidays: country.holidays,
      // Visitas de la historia ≈ meses × 26 días × profesionales × 5 citas: de ahí, cuántas son de alguien nuevo.
      firstVisitShare: Math.min(0.24, size.patients / (demo.months * 26 * Math.max(1, team.length) * 5)),
      person: (r) => kind.person(r, country),
      note: kind.note,
      diagnosisSystem: "ICD-11",
      inbound: kind.inbound,
      reply: kind.reply,
      budgets: kind.budgets,
      paymentMethods: country.paymentMethods,
      expenses: kind.expenses.map((item) => ({
        ...item,
        ...(item.cents !== undefined ? { cents: demoPriceCents(item.cents / 100, country) } : {}),
        ...(item.perStaffCents !== undefined ? { perStaffCents: demoPriceCents(item.perStaffCents / 100, country) } : {}),
      })),
      names: { given: [...country.given.F, ...country.given.M], surnames: country.surnames, bySex: country.given },
    },
  })

  // --- Lo que hicieron los agentes y lo que Argos ya respondió --------------------------------
  await step(3, "agentes")
  // Miles de filas recién escritas: sin sus estadísticas el planificador elige mal y lo que sigue tarda minutos.
  await tx.execute(sql`analyze appointment, conversation, message, patient, contact, encounter, patient_charge, patient_payment`)
  await seedReportsAgent(tx, {
    orgId,
    planCode: plan.code,
    months: demo.months,
    dictating: team.slice(0, 3).map((item, index) => ({ userId: item.userId, fromMonthsAgo: Math.max(1, Math.min(demo.months, [10, 6, 3][index] ?? 3)), share: [0.25, 0.6] as [number, number] })),
  })
  // Lo que cobra el plan cuenta el mes desde el alta; la demo nunca se factura.
  await tx.update(saasSubscription).set({ isDemo: true }).where(eq(saasSubscription.organizationId, orgId))
  await seedReportsPatients(tx, { orgId, ownerUserId: receptionUserId })
  await seedReportsArgos(tx, { orgId, ownerUserId: demo.presenterUserId, professionalUserId: (team[0] as TeamMember).userId })
  await seedSaasCostDemo(tx, { orgId, askers: [{ userId: demo.presenterUserId, weight: 3 }, ...team.slice(0, 2).map((item) => ({ userId: item.userId, weight: 1 }))] })

  // --- Hoy y las próximas dos semanas ---------------------------------------------------------
  await step(4, "hoy")
  const { timezone, currency } = await getOrgLocale(tx, orgId)
  const context: AgendaContext = { orgId, timezone, currency, kind, random, receptionUserId, team, rooms, services, paymentMethods: country.paymentMethods }
  const today = reportDayOf(timezone, now)
  // La historia termina dos días antes de hoy: desde ahí sigue la agenda.
  const historyEnd = now.getTime() - 2 * 86_400_000
  const through = addDays(today, HORIZON_DAYS)
  for (let day = addDays(today, -2); day <= through; day = addDays(day, 1)) await planDay(tx, context, day, historyEnd)
  await closeVisits(tx, context, now)
  await seedTodayInbox(tx, context, connection.id, today, size.professionals)
  await topUpFollowUps(tx, context, today)
  await step(5, "listo")
  return { organizationId: orgId, historyThrough: through }
}

/** Los servicios de la receta que la clínica ofrece, con su peso en la agenda. */
async function demoServices(tx: Db, orgId: string, kind: DemoKindRecipe): Promise<AgendaContext["services"]> {
  const rows = await tx
    .select({ id: serviceCatalog.id, name: serviceCatalog.name, priceCents: serviceCatalog.priceCents, durationMin: serviceCatalog.durationMin, key: treatmentTemplate.key })
    .from(serviceCatalog)
    .innerJoin(treatmentTemplate, eq(treatmentTemplate.id, serviceCatalog.templateId))
    .where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.isActive, true)))
  const offered = kind.services.flatMap((recipe) => {
    const row = rows.find((item) => item.key === recipe.template)
    return row && row.priceCents !== null
      ? [{ id: row.id, name: row.name, priceCents: row.priceCents, durationMin: row.durationMin ?? recipe.durationMin, weight: recipe.weight, firstVisit: recipe.firstVisit ?? false }]
      : []
  })
  // La primera visita es la primera de la receta que el país ofrece; las de respaldo quedan como una más.
  const first = offered.find((item) => item.firstVisit)
  return offered.map((item) => (item.firstVisit && item !== first ? { ...item, firstVisit: false, weight: Math.max(item.weight, 4) } : item))
}

/**
 * Las citas de un día, por reservar todavía: confirmadas, por confirmar y
 * algunas que agendó Sofi. Lo que ya pasó lo cierra `closeVisits`. Un día ya
 * con citas de la demo no se vuelve a llenar.
 */
async function planDay(tx: Db, ctx: AgendaContext, day: string, notBefore: number): Promise<void> {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  const start = dayStart(ctx.timezone, year, month, date)
  const weekday = new Date(start.getTime() + 12 * 3_600_000).getUTCDay()
  if (weekday === 0) return
  const end = new Date(start.getTime() + 86_400_000)
  const [existing] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(appointment)
    .where(and(eq(appointment.organizationId, ctx.orgId), gte(appointment.startsAt, start), lt(appointment.startsAt, end)))
  if ((existing?.count ?? 0) > 0 && start.getTime() >= notBefore) return
  const patients = (await tx.execute(sql`
    select p.id from patient p where p.organization_id = ${ctx.orgId}
    order by md5(p.id::text || ${day}) limit 400`)) as unknown as Array<{ id: string }>
  if (patients.length === 0) return
  const followUps = ctx.services.filter((item) => !item.firstVisit)
  const first = ctx.services.filter((item) => item.firstVisit)
  const rows: Array<typeof appointment.$inferInsert> = []
  // Lo que ya ocupa ese día (reservado a mano en una presentación): ni la
  // unidad ni el profesional atienden dos citas a la vez.
  const busy = new Map<string, Array<[number, number]>>()
  const take = (key: string, from: number, to: number): boolean => {
    const spans = busy.get(key) ?? []
    if (spans.some(([a, b]) => from < b && a < to)) return false
    busy.set(key, [...spans, [from, to]])
    return true
  }
  const free = (key: string, from: number, to: number): boolean => !(busy.get(key) ?? []).some(([a, b]) => from < b && a < to)
  for (const row of await tx
    .select({ roomId: appointment.roomId, professionalUserId: appointment.professionalUserId, startsAt: appointment.startsAt, endsAt: appointment.endsAt })
    .from(appointment)
    .where(and(eq(appointment.organizationId, ctx.orgId), inArray(appointment.status, ["programada", "confirmada"]), gte(appointment.startsAt, start), lt(appointment.startsAt, end)))) {
    take(`room:${row.roomId}`, row.startsAt.getTime(), row.endsAt.getTime())
    take(`pro:${row.professionalUserId}`, row.startsAt.getTime(), row.endsAt.getTime())
  }
  let cursor = 0
  for (const professional of ctx.team) {
    if (!professional.weekdays.includes(weekday)) continue
    const roomIds = ctx.rooms.get(professional.branchId) ?? []
    const hours = professional.afternoonOnly ? AFTERNOON : weekday === 6 ? MORNING : [...MORNING, ...AFTERNOON]
    for (const hour of hours) {
      // Quedan horas libres para que Sofi tenga dónde reservar.
      if (!ctx.random.chance(professional.occupancy * (hour >= 15 ? 0.7 : 0.9))) continue
      const startsAt = new Date(start.getTime() + hour * 3_600_000 + ctx.random.pick([0, 0, 15]) * 60_000)
      if (startsAt.getTime() < notBefore) continue
      const isFirst = ctx.random.chance(0.12) && first.length > 0
      const service = isFirst ? ctx.random.weighted(first) : ctx.random.weighted(followUps.length > 0 ? followUps : first)
      const from = startsAt.getTime()
      const to = from + service.durationMin * 60_000
      const roomId = roomIds.find((id) => free(`room:${id}`, from, to))
      if (!roomId || !free(`pro:${professional.userId}`, from, to)) continue
      take(`room:${roomId}`, from, to)
      take(`pro:${professional.userId}`, from, to)
      const patientId = (patients[cursor++ % patients.length] as { id: string }).id
      const sourceRoll = ctx.random.next()
      rows.push({
        id: randomUUID(),
        organizationId: ctx.orgId,
        branchId: professional.branchId,
        roomId,
        patientId,
        professionalUserId: professional.userId,
        serviceId: service.id,
        serviceName: service.name,
        startsAt,
        endsAt: new Date(startsAt.getTime() + service.durationMin * 60_000),
        durationMin: service.durationMin,
        status: ctx.random.chance(0.62) ? "confirmada" : "programada",
        source: sourceRoll < 0.34 ? "agent" : sourceRoll < 0.4 ? "enlace" : "recepcion",
        createdBy: ctx.receptionUserId,
        createdAt: new Date(startsAt.getTime() - ctx.random.int(1, 12) * 86_400_000),
      })
    }
  }
  for (const batch of chunks(rows)) await tx.insert(appointment).values(batch)
}

/**
 * Cierra las citas de la demo que ya pasaron: la mayoría se atendió (con su
 * atención firmada, lo cobrado y lo escrito por la receta) y unas pocas
 * faltaron. Lo que la persona que presenta movió a mano no se toca: solo se
 * cierran las que siguen programadas o confirmadas.
 */
async function closeVisits(tx: Db, ctx: AgendaContext, before: Date): Promise<number> {
  const due = await tx
    .select({
      id: appointment.id,
      patientId: appointment.patientId,
      branchId: appointment.branchId,
      professionalUserId: appointment.professionalUserId,
      serviceId: appointment.serviceId,
      serviceName: appointment.serviceName,
      startsAt: appointment.startsAt,
      durationMin: appointment.durationMin,
    })
    .from(appointment)
    .where(and(eq(appointment.organizationId, ctx.orgId), inArray(appointment.status, ["programada", "confirmada"]), lt(appointment.endsAt, new Date(before.getTime() - 30 * 60_000))))
  if (due.length === 0) return 0
  // Una atención en borrador por persona: quien ya tiene una no se cierra aquí.
  const drafts = new Set(
    (await tx.select({ patientId: encounter.patientId }).from(encounter).where(and(eq(encounter.organizationId, ctx.orgId), eq(encounter.status, "borrador")))).map((row) => row.patientId),
  )
  const tax = chargeTaxOf(await orgTaxes(tx, ctx.orgId), false)
  const missed: string[] = []
  const attended: typeof due = []
  for (const visit of due) {
    if (ctx.random.chance(0.08) || drafts.has(visit.patientId)) missed.push(visit.id)
    else attended.push(visit)
  }
  if (missed.length > 0) await tx.update(appointment).set({ status: "no_asistio" }).where(inArray(appointment.id, missed))
  const priceOf = new Map(ctx.services.map((item) => [item.id, item]))
  for (const batch of chunks(attended, 200)) {
    const people = new Map(
      (
        await tx.execute(sql`
          select p.id, c.birth_date, c.sex from patient p join contact c on c.organization_id = p.organization_id and c.id = p.person_id
          where p.organization_id = ${ctx.orgId} and p.id in (${sql.join(batch.map((item) => sql`${item.patientId}::uuid`), sql`, `)})`)
      ).map((row) => {
        const value = row as { id: string; birth_date: string | null; sex: "F" | "M" | null }
        return [value.id, value.birth_date ? { birthDate: String(value.birth_date).slice(0, 10), sex: value.sex ?? "F" } : null] as const
      }),
    )
    // Un paciente con dos citas cerradas a la vez: la segunda espera a la próxima noche.
    const seen = new Set<string>()
    const unique = batch.filter((visit) => (seen.has(visit.patientId) ? false : (seen.add(visit.patientId), true)))
    const rows = unique.map((visit) => {
      const professional = ctx.team.find((item) => item.userId === visit.professionalUserId)
      const service = (visit.serviceId ? priceOf.get(visit.serviceId) : undefined) ?? ctx.services[0]
      const startedAt = new Date(visit.startsAt.getTime() + ctx.random.int(0, 12) * 60_000)
      const endedAt = new Date(startedAt.getTime() + visit.durationMin * 60_000)
      const note = ctx.kind.note({ name: visit.serviceName ?? service?.name ?? "" }, ctx.random, people.get(visit.patientId) ?? null)
      return { visit, professional, service, note, startedAt, endedAt, encounterId: randomUUID(), procedureId: randomUUID(), chargeId: randomUUID() }
    })
    await tx
      .update(appointment)
      .set({ status: "atendida", arrivedAt: sql`${appointment.startsAt} - interval '5 minutes'`, arrivedBy: ctx.receptionUserId })
      .where(inArray(appointment.id, rows.map((row) => row.visit.id)))
    if (rows.length === 0) continue
    await tx.insert(encounter).values(
      rows.map((row) => ({
        id: row.encounterId,
        organizationId: ctx.orgId,
        patientId: row.visit.patientId,
        branchId: row.visit.branchId,
        professionalUserId: row.visit.professionalUserId,
        appointmentId: row.visit.id,
        reason: row.visit.serviceName,
        evolution: row.note.evolution,
        ...(row.note.vitals ? { vitals: row.note.vitals } : {}),
        ...(row.note.examination ? { examination: row.note.examination } : {}),
        startedAt: row.startedAt,
        signerName: row.professional?.signerName ?? null,
        signerTitle: row.professional?.title ?? null,
        signerRegistration: row.professional?.registration ?? null,
      })),
    )
    const diagnosed = rows.filter((row) => row.note.diagnosisCode)
    if (diagnosed.length > 0)
      await tx.insert(encounterDiagnosis).values(
        diagnosed.map((row) => ({
          organizationId: ctx.orgId,
          patientId: row.visit.patientId,
          encounterId: row.encounterId,
          diagnosisSystem: "ICD-11",
          diagnosisCode: row.note.diagnosisCode as string,
          diagnosisType: "confirmed",
          status: "resuelto",
          resolvedAt: row.endedAt,
          createdBy: row.visit.professionalUserId,
          createdAt: row.endedAt,
        })),
      )
    const priced = rows.filter((row) => row.service)
    if (priced.length > 0) await tx.insert(encounterProcedure).values(
      priced.map((row) => ({
        id: row.procedureId,
        organizationId: ctx.orgId,
        encounterId: row.encounterId,
        serviceId: row.service?.id ?? null,
        description: row.service?.name ?? "",
        quantity: 1,
        priceCents: row.service?.priceCents ?? 0,
        currency: ctx.currency,
        createdBy: row.visit.professionalUserId,
        createdAt: row.endedAt,
      })),
    )
    // Lo escrito entra con la atención en borrador; se cierra con la firma y la hora de fin.
    await tx.execute(sql`
      update encounter e set status = 'finalizada', ended_at = v.ended_at, finalized_at = v.ended_at, finalized_by = e.professional_user_id
      from (values ${sql.join(rows.map((row) => sql`(${row.encounterId}::uuid, ${row.endedAt.toISOString()}::timestamptz)`), sql`, `)}) as v(id, ended_at)
      where e.organization_id = ${ctx.orgId} and e.id = v.id`)
    if (priced.length === 0) continue
    await tx.insert(patientCharge).values(
      priced.map((row) => ({
        id: row.chargeId,
        organizationId: ctx.orgId,
        patientId: row.visit.patientId,
        encounterProcedureId: row.procedureId,
        branchId: row.visit.branchId,
        description: row.service?.name ?? "",
        amountCents: row.service?.priceCents ?? 0,
        currency: ctx.currency,
        ...(tax ?? {}),
        createdBy: row.visit.professionalUserId,
        createdAt: row.endedAt,
      })),
    )
    // Casi todo se cobra el mismo día; algunos quedan debiendo (de ahí «Te deben»).
    const paid = priced.filter(() => ctx.random.chance(0.88))
    const methods = ctx.paymentMethods
    const payments = paid.map((row) => {
      const method = ctx.random.weighted(methods)
      const cents = row.service?.priceCents ?? 0
      return {
        row,
        payment: {
          id: randomUUID(),
          organizationId: ctx.orgId,
          patientId: row.visit.patientId,
          branchId: row.visit.branchId,
          amountCents: cents,
          taxCents: tax?.taxCategory === "S" ? includedTaxCents(cents, tax.taxBps) : 0,
          currency: ctx.currency,
          paidAt: new Date(row.endedAt.getTime() + 5 * 60_000),
          methodName: method.name,
          methodTypeCode: method.typeCode,
          createdBy: ctx.receptionUserId,
        },
      }
    })
    if (payments.length > 0) {
      await tx.insert(patientPayment).values(payments.map((item) => item.payment))
      await tx.insert(patientPaymentApplication).values(
        payments.map((item) => ({
          organizationId: ctx.orgId,
          patientId: item.row.visit.patientId,
          paymentId: item.payment.id,
          chargeId: item.row.chargeId,
          amountCents: item.payment.amountCents,
          createdBy: ctx.receptionUserId,
          createdAt: item.payment.paidAt,
        })),
      )
    }
  }
  return due.length
}

/**
 * La Bandeja de hoy: temas que esperan a una persona, conversaciones que
 * atiende Sofi y otras que esperan respuesta del paciente. Si hoy ya tiene las
 * suyas, no agrega otras.
 */
async function seedTodayInbox(tx: Db, ctx: AgendaContext, connectionId: string, today: string, professionals: number): Promise<void> {
  const thread = `demo-${today}-`
  const [already] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(message)
    .where(and(eq(message.organizationId, ctx.orgId), like(message.externalId, `${thread}%`)))
  if ((already?.count ?? 0) > 0) return
  const writers = (await tx.execute(sql`
    select coalesce(g.contact_id, p.person_id) as contact_id
    from patient p
    left join patient_contact g on g.organization_id = p.organization_id and g.patient_id = p.id and g.relationship = 'guardian'
    where p.organization_id = ${ctx.orgId}
    order by md5(p.id::text || ${today}) limit 60`)) as unknown as Array<{ contact_id: string }>
  if (writers.length === 0) return
  const now = Date.now()
  const total = Math.min(writers.length, 4 + professionals * 3)
  for (let index = 0; index < total; index += 1) {
    const contactId = (writers[index] as { contact_id: string }).contact_id
    const asked = new Date(now - ctx.random.int(5, 300) * 60_000)
    const answered = new Date(asked.getTime() + ctx.random.int(20, 90) * 1000)
    const topic = index < ctx.kind.openTopics.length ? (ctx.kind.openTopics[index] as string) : null
    const waitsPatient = !topic && index % 3 === 0
    const conv = await seedConversationIn(tx, {
      orgId: ctx.orgId,
      contactId,
      connectionId,
      thread: `${thread}${index}`,
      unreadCount: topic ? 1 : 0,
      lastInboundAt: topic ? new Date(answered.getTime() + 60_000) : asked,
      lastOutboundAt: answered,
      lastMessageAt: topic ? new Date(answered.getTime() + 60_000) : answered,
    })
    await seedMessageIn(tx, { orgId: ctx.orgId, conversationId: conv.id, direction: "in", senderKind: "contact", body: ctx.random.pick(ctx.kind.inbound), externalId: `${thread}${index}-a`, status: "received", createdAt: asked })
    await seedMessageIn(tx, { orgId: ctx.orgId, conversationId: conv.id, direction: "out", senderKind: "agent", body: ctx.random.pick(ctx.kind.reply), externalId: `${thread}${index}-b`, status: waitsPatient ? "read" : "delivered", createdAt: answered })
    if (topic) {
      const question = await seedMessageIn(tx, { orgId: ctx.orgId, conversationId: conv.id, direction: "in", senderKind: "contact", body: topic, externalId: `${thread}${index}-c`, status: "received", createdAt: new Date(answered.getTime() + 60_000) })
      await createHandoff(tx, ctx.orgId, null, {
        conversationId: conv.id,
        reason: topic,
        summary: `Escribió: «${topic}»`,
        priority: "media",
        createdBy: "agent",
        sourceMessageId: question.id,
      })
    }
  }
}

/**
 * Los controles que vencen este mes (la receta dice cuál y cada cuánto): así
 * «Controles» y Sofi tienen a quién avisar. Solo agrega lo que falta.
 */
async function topUpFollowUps(tx: Db, ctx: AgendaContext, today: string): Promise<void> {
  const followUp = ctx.kind.followUp
  if (!followUp) return
  const [year, month] = today.split("-").map(Number) as [number, number]
  const monthStart = dayStart(ctx.timezone, year, month, 1)
  const [open] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(clinicalFollowUp)
    .where(and(eq(clinicalFollowUp.organizationId, ctx.orgId), eq(clinicalFollowUp.status, "pendiente"), gte(clinicalFollowUp.dueAt, monthStart)))
  const wanted = 8 + ctx.team.length * 4
  const missing = wanted - (open?.count ?? 0)
  if (missing <= 0) return
  const origins = (await tx.execute(sql`
    select distinct on (e.patient_id) e.id, e.patient_id, e.professional_user_id
    from encounter e
    where e.organization_id = ${ctx.orgId} and e.status = 'finalizada'
      and not exists (select 1 from clinical_follow_up f where f.organization_id = e.organization_id and f.patient_id = e.patient_id and f.status = 'pendiente')
    order by e.patient_id, e.ended_at desc
    limit ${missing}`)) as unknown as Array<{ id: string; patient_id: string; professional_user_id: string }>
  if (origins.length === 0) return
  await tx.insert(clinicalFollowUp).values(
    origins.map((origin) => ({
      organizationId: ctx.orgId,
      patientId: origin.patient_id,
      originEncounterId: origin.id,
      kind: "mantenimiento",
      title: followUp.title,
      dueAt: new Date(monthStart.getTime() + ctx.random.int(0, 27) * 86_400_000 + 10 * 3_600_000),
      status: "pendiente",
      repeatEveryMonths: followUp.everyMonths,
      createdBy: origin.professional_user_id,
    })),
  )
}

/** El equipo de la demo, como lo dejó `buildDemo`, para seguir su agenda. */
async function agendaContextOf(tx: Db, demo: DemoRecipeRef, orgId: string, today: string): Promise<AgendaContext> {
  const kind = demoKindOf(demo.product, demo.kind)
  const { timezone, currency } = await getOrgLocale(tx, orgId)
  const schedules = (await tx.execute(sql`
    select s.professional_user_id, s.branch_id, array_agg(distinct s.weekday) as weekdays, min(s.start_min) as first_min,
      pp.signature_name, pp.registration_number, pp.professional_title
    from professional_schedule s
    left join professional_profile pp on pp.organization_id = s.organization_id and pp.user_id = s.professional_user_id
    where s.organization_id = ${orgId}
    group by s.professional_user_id, s.branch_id, pp.signature_name, pp.registration_number, pp.professional_title
    order by s.professional_user_id`)) as unknown as Array<{
    professional_user_id: string
    branch_id: string
    weekdays: number[]
    first_min: number
    signature_name: string | null
    registration_number: string | null
    professional_title: string | null
  }>
  const rooms = new Map<string, string[]>()
  for (const row of (await tx.execute(sql`select branch_id, id from schedule_room where organization_id = ${orgId} order by name`)) as unknown as Array<{ branch_id: string; id: string }>)
    rooms.set(row.branch_id, [...(rooms.get(row.branch_id) ?? []), row.id])
  return {
    orgId,
    timezone,
    currency,
    kind,
    // La noche de cada día da su propia agenda, siempre la misma para ese día.
    random: generator((demo.seed ^ Number(today.replaceAll("-", ""))) >>> 0),
    receptionUserId: `${demoUserPrefix(demo.id)}recepcion`,
    team: schedules.map((row) => ({
      userId: row.professional_user_id,
      name: row.signature_name ?? "",
      signerName: row.signature_name ?? "",
      registration: row.registration_number ?? "",
      title: row.professional_title ?? "",
      branchId: row.branch_id,
      weekdays: row.weekdays.map(Number),
      afternoonOnly: Number(row.first_min) >= 14 * 60,
      occupancy: kind.occupancy,
    })),
    rooms,
    services: await demoServices(tx, orgId, kind),
    paymentMethods: demoCountryOf(demo.countryCode).paymentMethods,
  }
}

/**
 * Pone la demo al día (cada noche, decisión 5): cierra lo que pasó, llena los
 * días que entran en las dos semanas, cierra las conversaciones viejas y deja
 * la Bandeja y los controles de hoy. Es idempotente para un mismo día.
 */
export async function advanceDemo(tx: Db, demo: DemoRecipeRef & { organizationId: string; historyThrough: string | null }): Promise<{ historyThrough: string; today: string }> {
  const { timezone } = await getOrgLocale(tx, demo.organizationId)
  const now = new Date()
  const today = reportDayOf(timezone, now)
  const ctx = await agendaContextOf(tx, demo, demo.organizationId, today)
  await closeVisits(tx, ctx, now)
  const through = addDays(today, HORIZON_DAYS)
  const from = demo.historyThrough && demo.historyThrough >= today ? addDays(demo.historyThrough, 1) : today
  for (let day = from; day <= through; day = addDays(day, 1)) await planDay(tx, ctx, day, now.getTime())
  // Lo de días anteriores ya se resolvió: la Bandeja queda con lo de hoy.
  await tx.execute(sql`
    update conversation set status = 'closed', closed_at = now(), close_reason = 'resuelta', unread_count = 0
    where organization_id = ${demo.organizationId} and status <> 'closed' and last_message_at < now() - interval '36 hours'`)
  // Un tema se resuelve con su tarea (`resolveTopic`).
  await tx.execute(sql`
    update task set status = 'done', updated_at = now()
    where organization_id = ${demo.organizationId} and status = 'open'
      and id in (select task_id from agent_handoff where organization_id = ${demo.organizationId} and task_id is not null and created_at < now() - interval '36 hours')`)
  const [connection] = await tx.select({ id: channelConnection.id }).from(channelConnection).where(eq(channelConnection.organizationId, demo.organizationId)).limit(1)
  if (connection) await seedTodayInbox(tx, ctx, connection.id, today, ctx.team.length)
  await topUpFollowUps(tx, ctx, today)
  return { historyThrough: through, today }
}

/** Lo que un borrado tiene que quitar del almacenamiento después de confirmar la transacción. */
export interface DemoPurgeResult {
  storageKeys: string[]
}

/**
 * Borra entera la clínica de una demo (decisión del 2026-10-27: una clínica
 * real nunca se borra). Solo actúa sobre una organización que tenga su fila
 * en `admin.saas_demo`: marcar «modo demo» en Cobros no basta. Las tablas se
 * leen de la base (toda tabla de una clínica lleva `organization_id`), así
 * que una tabla nueva no deja nada atrás. Las comprobaciones de la base
 * (claves foráneas, la caja que no se borra) se suspenden solo dentro de
 * esta transacción: exige la conexión owner del worker.
 */
export async function purgeDemoOrganization(tx: Db, demoId: string, orgId: string): Promise<DemoPurgeResult> {
  const [owned] = await tx
    .select({ id: saasDemo.id })
    .from(saasDemo)
    .where(and(eq(saasDemo.id, demoId), eq(saasDemo.organizationId, orgId)))
    .limit(1)
  if (!owned) throw new ServiceError("NOT_FOUND", 404, "Esa clínica no es una demo")
  const [role] = (await tx.execute(sql`select rolsuper from pg_roles where rolname = current_user`)) as unknown as Array<{ rolsuper: boolean }>
  if (!role?.rolsuper) throw new ServiceError("CONFLICT", 409, "Borrar una demo necesita la conexión owner del worker")
  const documents = await tx.select({ key: patientDocument.storageKey }).from(patientDocument).where(and(eq(patientDocument.organizationId, orgId), isNotNull(patientDocument.storageKey)))
  const attachments = await tx.select({ attachments: message.attachments }).from(message).where(eq(message.organizationId, orgId))
  const storageKeys = [
    ...documents.map((row) => row.key),
    ...attachments.flatMap((row) =>
      Array.isArray(row.attachments)
        ? row.attachments.flatMap((item) => (item && typeof item === "object" && "objectKey" in item && typeof item.objectKey === "string" ? [item.objectKey] : []))
        : [],
    ),
  ].filter((key): key is string => Boolean(key))
  const tables = (await tx.execute(sql`
    select c.table_schema, c.table_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.column_name = 'organization_id' and t.table_type = 'BASE TABLE'
      and c.table_schema not in ('admin', 'pg_catalog', 'information_schema')`)) as unknown as Array<{ table_schema: string; table_name: string }>
  await tx.execute(sql`set local session_replication_role = replica`)
  for (const table of tables) {
    await tx.execute(sql`delete from ${sql.identifier(table.table_schema)}.${sql.identifier(table.table_name)} where organization_id = ${orgId}`)
  }
  // De la administración solo lo que es de la clínica; su registro de auditoría queda.
  for (const table of ["saas_commission_settlement_line", "saas_commission_adjustment", "saas_seller_commission", "saas_negotiation"])
    await tx.execute(sql`delete from admin.${sql.identifier(table)} where organization_id = ${orgId}`)
  await tx.execute(sql`update admin.saas_waitlist_request set organization_id = null where organization_id = ${orgId}`)
  await tx.update(saasDemo).set({ organizationId: null }).where(eq(saasDemo.id, demoId))
  await tx.delete(organization).where(eq(organization.id, orgId))
  await tx.execute(sql`set local session_replication_role = origin`)
  // El equipo inventado se va con su clínica; si algo lo nombra todavía, la base lo dice aquí.
  await tx.delete(user).where(like(user.id, `${demoUserPrefix(demoId)}%`))
  return { storageKeys }
}
