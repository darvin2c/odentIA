import { randomUUID } from "node:crypto"
import { LEGAL } from "@odentia/auth/legal"
import type { ClinicalProduct } from "@odentia/clinical"
import { DEFAULT_REGISTRATION_CONFIG, includedTaxCents, type MedicationEntry } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import type { DemoProgress, DemoSize } from "@odentia/db/schema/admin-demos"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import { agentRunLedger } from "@odentia/db/schema/agent"
import { appointment } from "@odentia/db/schema/agenda"
import { member, organization, user } from "@odentia/db/schema/auth"
import {
  clinicalFollowUp,
  encounter,
  encounterDiagnosis,
  encounterProcedure,
  orgSpecialty,
  patientCharge,
  patientDocument,
  serviceCatalog,
  treatmentTemplate,
} from "@odentia/db/schema/clinical"
import { professionalSpecialty } from "@odentia/db/schema/clinical-forms"
import { channelConnection, conversation, message } from "@odentia/db/schema/crm"
import { cashShift } from "@odentia/db/schema/finance"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { processingAgreementAcceptance } from "@odentia/db/schema/workspace"
import { and, eq, gte, inArray, isNotNull, like, lt, sql } from "drizzle-orm"
import { createHandoff } from "./agent-operations.js"
import { upsertAgentConfig } from "./agentConfig.js"
import { createRoom } from "./appointments.js"
import { setProfessionalSchedule } from "./availability.js"
import { chargeTaxOf, orgTaxes } from "./clinic-taxes.js"
import { ensureClinicConsents, setProfessionalSpecialties } from "./clinical-forms.js"
import { createConnection, setConnectionStatus } from "./connections.js"
import { reopenIfClosed } from "./conversations.js"
import {
  DEMO_COUNTRIES,
  DEMO_SIZE_RECIPES,
  type DemoCountry,
  type DemoKindRecipe,
  type DemoWho,
  demoPriceCents,
} from "./demo-recipes.js"
import { closeShift, getShiftDetail } from "./finance.js"
import { seedDemoSignature } from "./demo-signature.js"
import { ServiceError } from "./errors.js"
import { getOrgLocale } from "./locale.js"
import { initialOrgRegion } from "./organization-profile.js"
import { ensureDefaultPaymentMethods } from "./payment-methods.js"
import { ensureDefaultPipeline } from "./pipelines.js"
import { demoKindsFor, dictationFor, productHooks } from "./products.js"
import { setProfessionalProfile } from "./professional-profiles.js"
import { addDays, dayStart, reportDayOf } from "./report-periods.js"
import { defaultPlanOf } from "./saas-plan-product.js"
import { seedChannelTemplates } from "./seed-automation.js"
import { seedConversationIn, seedMessageIn } from "./seed-common.js"
import { insertSeedPayments, type SeedCharge, type SeedPayment } from "./seed-payments.js"
import {
  chunks,
  generator,
  insertSeedPapers,
  knownDiagnosisCodes,
  promotionFor,
  type Random,
  seedReports,
  whoFits,
} from "./seed-reports.js"
import { seedReportsAgent } from "./seed-reports-agent.js"
import { seedReportsArgos } from "./seed-reports-argos.js"
import { seedReportsPatients } from "./seed-reports-patients.js"
import { seedAcceptedProgress } from "./seed-reports-progress.js"
import { demoPromotionsOf, seedOperation, seedPromotions } from "./seed-operation.js"
import { seedRepliesRuns, seedSaasCostDemo } from "./seed-saas-cost.js"
import { savePatientRegistrationConfig } from "./patient-registration.js"
import { fromTemplates, updateService } from "./service-catalog.js"
import { librarySpecialtyIds } from "./specialties.js"

/**
 * Cómo se nombra a quien atiende en cada producto: el odontólogo y el médico, «Dr.»
 * o «Dra.»; el optómetra, tecnólogo médico con licenciatura, «Lic.».
 */
const CLINICIAN_HONORIFIC: Record<ClinicalProduct, Record<"F" | "M", string>> = {
  dental: { F: "Dra.", M: "Dr." },
  medical: { F: "Dra.", M: "Dr." },
  optical: { F: "Lic.", M: "Lic." },
}

/**
 * Quien atiende el mostrador de la demo: recepción; en una óptica, Ventas, que
 * también vende y cobra (ADR 0171). Su usuario es el mismo (`…recepcion`).
 */
const DEMO_DESK_ROLE: Record<ClinicalProduct, "reception" | "sales"> = { dental: "reception", medical: "reception", optical: "sales" }
/** Quien hace los lentes en el taller propio: solo una óptica lo tiene (ADR 0171). */
const DEMO_HAS_WORKSHOP: Record<ClinicalProduct, boolean> = { dental: false, medical: false, optical: true }

/** Cómo se llama cada sala de la demo en cada producto: «Unidad 1», «Consultorio 1», «Sala de examen 1». */
const DEMO_ROOM: Record<ClinicalProduct, string> = { dental: "Unidad", medical: "Consultorio", optical: "Sala de examen" }

/**
 * El motor de las demos para presentar (ADR 0096). Arma una clínica inventada
 * con la receta de su tipo: el equipo sin cuentas, su tarifario, meses de
 * historia (`seedReports` y las demás semillas de Reportes con la receta) y
 * las próximas dos semanas. Cada noche `advanceDemo` cierra los días que
 * pasaron y agrega los que entran, para que la agenda de hoy siempre tenga
 * algo que mostrar. Todo corre con la conexión owner del worker y en una sola
 * transacción: una demo nunca queda a medias. Nada sale a una persona: su
 * WhatsApp queda desconectado (no recibe ni envía, y así lo dice), los
 * teléfonos son del rango de ficción, de +44 7700 900000 a 900799 (el resto
 * queda para la QA), y los correos, de example.com.
 *
 * La demo cuenta una clínica coherente: cada servicio lo atiende quien tiene
 * su especialidad y a quien le corresponde por edad y sexo, cada cobro tiene
 * su ticket y su caja, cada respuesta de Sofi su corrida, y quien escribe por
 * WhatsApp tiene su número (`saas-demos-coherence.test.ts` lo comprueba).
 */

/** Los pasos del armado que dice el avance: equipo, tarifario, historia, agentes, hoy y operación. */
export const DEMO_BUILD_STEPS = 6

/** Días de agenda hacia adelante. */
const HORIZON_DAYS = 14
/**
 * Los teléfonos de la demo son del rango que Ofcom reserva para la ficción
 * (+44 7700 900000 a 900999): nunca son de una persona real, aunque la clínica
 * sea de Perú, Colombia o México. Las semillas usan solo de 900000 a 900799:
 * de 900800 a 900999 queda libre para lo que crea la QA, que así no choca con
 * un contacto de la demo (QA del 10 nov, D1). El 900799 es el de la clínica;
 * los otros 799, de quienes escriben por WhatsApp. Un número de WhatsApp es de
 * una sola persona en la clínica: si escriben más, los demás quedan sin número
 * antes que repetir uno o salir del tramo.
 */
const FICTION_PHONE_PREFIX = "447700900"
/** El último número del tramo de las semillas: después empieza el de la QA. */
const SEED_PHONE_LAST = 799

/** Los números de la demo, sin el «+»: el de la clínica y, en orden, los de quienes escriben. */
export function demoFictionPhones(): { clinic: string; writers: string[] } {
  const number = (n: number): string => `${FICTION_PHONE_PREFIX}${String(n).padStart(3, "0")}`
  return {
    clinic: number(SEED_PHONE_LAST),
    writers: Array.from({ length: SEED_PHONE_LAST }, (_, n) => number(n)),
  }
}

const DEMO_CLINIC_PHONE = `+${demoFictionPhones().clinic}`
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
  if (!kind) {
    const message = "Ese tipo de demo no existe para el producto"
    throw new ServiceError("VALIDATION", 400, message, { kind: message })
  }
  return kind
}

export function demoCountryOf(code: string): DemoCountry {
  const country = DEMO_COUNTRIES[code as DemoCountry["code"]]
  if (!country) {
    const message = "Las demos son de Perú, Colombia o México"
    throw new ServiceError("VALIDATION", 400, message, { countryCode: message })
  }
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
  /** La especialidad que atiende (tipo de la biblioteca); nula, todas las de la receta. */
  specialty: string | null
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
  services: DemoService[]
  paymentMethods: DemoCountry["paymentMethods"]
  holidays: ReadonlySet<string>
  /** La lista de medicamentos del producto: el código ATC de lo que se receta. */
  medications: readonly MedicationEntry[]
}

/** Un servicio del tarifario de la demo, con lo que la receta dice de él. */
interface DemoService {
  id: string
  name: string
  priceCents: number
  durationMin: number
  weight: number
  firstVisit: boolean
  specialty?: string
  who?: DemoWho
  perUnit?: boolean
}

/** El tipo de la biblioteca de cada profesional: el de su lugar en la rotación, o el de la receta. */
const specialtyOfIndex = (kind: DemoKindRecipe, index: number): string | null =>
  kind.specialtyRotation?.[index] ?? kind.professional.specialty

/** Si el profesional da ese servicio: sin especialidad, cualquiera; con ella, quien la atiende. */
const attends = (professional: { specialty: string | null }, service: { specialty?: string }): boolean =>
  !service.specialty || !professional.specialty || service.specialty === professional.specialty

/** A quién atiende el profesional y a quién se le da el servicio. */
const needOf = (kind: DemoKindRecipe, professional: { specialty: string | null }, service: { who?: DemoWho }): Array<DemoWho | undefined> => [
  professional.specialty ? kind.specialtyWho?.[professional.specialty] : undefined,
  service.who,
]

/**
 * Lo que dicen Sofi y quienes escriben, con los datos de la demo (ADR 0120):
 * `{especialidades}` es la lista de las que atiende el equipo, como las nombra
 * la clínica, y `{la doctora}` dice «la doctora» si el equipo es de doctoras,
 * «el doctor» si es de doctores y «el médico» si hay de los dos.
 */
async function demoTexts(
  tx: Db,
  orgId: string,
  kind: DemoKindRecipe,
  specialties: readonly string[],
  sexes: ReadonlyArray<"F" | "M">,
): Promise<DemoKindRecipe> {
  const ids = await librarySpecialtyIds(tx, orgId, specialties)
  const names = ids.size
    ? (
        await tx
          .select({ id: orgSpecialty.id, name: orgSpecialty.name })
          .from(orgSpecialty)
          .where(and(eq(orgSpecialty.organizationId, orgId), inArray(orgSpecialty.id, [...new Set(ids.values())])))
      ).map((row) => row.name.toLocaleLowerCase("es"))
    : []
  const list =
    names.length <= 1 ? (names[0] ?? kind.name.toLocaleLowerCase("es")) : `${names.slice(0, -1).join(", ")} y ${names.at(-1)}`
  const doctor = sexes.every((sex) => sex === "F") ? "la doctora" : sexes.every((sex) => sex === "M") ? "el doctor" : "el médico"
  const said = (texts: readonly string[]) =>
    texts.map((text) =>
      text
        .replaceAll("{especialidades}", list)
        .replaceAll("{la doctora}", doctor)
        .replaceAll("{La doctora}", `${doctor.charAt(0).toLocaleUpperCase("es")}${doctor.slice(1)}`),
    )
  return { ...kind, inbound: said(kind.inbound), reply: said(kind.reply), openTopics: said(kind.openTopics) }
}

/**
 * Arma la demo entera dentro de `tx`. `onProgress` va fuera de la transacción
 * (lo escribe el worker con otra conexión): dice en qué paso va.
 */
export async function buildDemo(
  tx: Db,
  demo: DemoRecipeRef,
  deps: {
    secretsKey: Buffer
    fetch: typeof fetch
    onProgress?: (progress: DemoProgress) => Promise<void> | void
    /** Volver a empezar: la clínica nueva conserva el id de la anterior (su ficha y sus enlaces siguen). */
    organizationId?: string
  },
): Promise<{ organizationId: string; historyThrough: string; slug: string }> {
  const kind = demoKindOf(demo.product, demo.kind)
  const country = demoCountryOf(demo.countryCode)
  const size = DEMO_SIZE_RECIPES[demo.size]
  const random = generator(demo.seed)
  const step = async (done: number, name: string) =>
    deps.onProgress?.({ step: name, done, total: DEMO_BUILD_STEPS })
  const now = new Date()
  await step(0, "equipo")

  // --- La clínica, del producto y país de la receta -----------------------------------------
  const orgId = deps.organizationId ?? randomUUID()
  const region = initialOrgRegion({ countryCode: country.code, timezone: country.timezone })
  // El subdominio se pidió al crearla: si otra clínica lo tomó mientras tanto, lleva un número.
  const slug = await freeDemoSlug(tx, demo.slug)
  await tx.insert(organization).values({ id: orgId, name: demo.name, slug, createdAt: now })
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
  const [plan] = await tx
    .select({ id: saasPlan.id, code: saasPlan.code })
    .from(saasPlan)
    .where(defaultPlanOf(demo.product))
    .limit(1)
  if (!plan)
    throw new ServiceError(
      "CONFLICT",
      409,
      "Falta el plan de lista del producto: créalo en «Cobros y planes»",
    )
  // El disparador abrió la suscripción; la demo no se cobra y muestra el gasto con su plan.
  await tx
    .update(saasSubscription)
    .set({ isDemo: true, planId: plan.id })
    .where(eq(saasSubscription.organizationId, orgId))

  // Quien presenta entra como propietario y la clínica aceptó el contrato de encargo por él.
  await tx
    .insert(member)
    .values({
      id: randomUUID(),
      organizationId: orgId,
      userId: demo.presenterUserId,
      role: "owner",
      createdAt: now,
    })
  await tx
    .insert(processingAgreementAcceptance)
    .values({
      organizationId: orgId,
      version: LEGAL.agreement.version,
      acceptedBy: demo.presenterUserId,
    })

  // --- Sedes, consultorios y el equipo sin cuentas --------------------------------------------
  const places = [...country.places].sort(() => random.next() - 0.5)
  const branches: Array<{ id: string; rent: number }> = []
  for (let index = 0; index < size.branches; index += 1) {
    const [row] = await tx
      .insert(branch)
      .values({
        organizationId: orgId,
        name: `Sede ${places[index] ?? index + 1}`,
        country: country.code,
      })
      .returning({ id: branch.id })
    branches.push({
      id: (row as { id: string }).id,
      rent: demoPriceCents(index === 0 ? 5_500 : 4_200, country),
    })
  }
  const roomWord = DEMO_ROOM[demo.product]
  const rooms = new Map<string, string[]>()
  for (const item of branches) {
    const ids: string[] = []
    for (let index = 0; index < size.rooms; index += 1)
      ids.push(
        (await createRoom(tx, orgId, { branchId: item.id, name: `${roomWord} ${index + 1}` })).id,
      )
    rooms.set(item.id, ids)
  }

  const prefix = demoUserPrefix(demo.id)
  const terms = { termsVersion: LEGAL.terms.version, termsAcceptedAt: now }
  const people: Array<{
    id: string
    role: "clinician" | "reception" | "cashier" | "sales" | "workshop"
    sex: "F" | "M"
    given: string
    family: string
  }> = []
  for (let index = 0; index < size.professionals; index += 1) {
    const sex = random.chance(0.55) ? "F" : "M"
    people.push({
      id: `${prefix}${index + 1}`,
      role: "clinician",
      sex,
      given: random.pick(country.given[sex]),
      family: random.pick(country.surnames),
    })
  }
  people.push({
    id: `${prefix}recepcion`,
    role: DEMO_DESK_ROLE[demo.product],
    sex: "F",
    given: random.pick(country.given.F),
    family: random.pick(country.surnames),
  })
  if (DEMO_HAS_WORKSHOP[demo.product])
    people.push({
      id: `${prefix}taller`,
      role: "workshop",
      sex: "M",
      given: random.pick(country.given.M),
      family: random.pick(country.surnames),
    })
  if (demo.size !== "pequeno")
    people.push({
      id: `${prefix}caja`,
      role: "cashier",
      sex: "M",
      given: random.pick(country.given.M),
      family: random.pick(country.surnames),
    })
  await tx.insert(user).values(
    people.map((person, index) => {
      const honorific = person.role === "clinician" ? `${CLINICIAN_HONORIFIC[demo.product][person.sex]} ` : ""
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
  await tx
    .insert(member)
    .values(
      people.map((person) => ({
        id: randomUUID(),
        organizationId: orgId,
        userId: person.id,
        role: person.role,
        createdAt: now,
      })),
    )
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
    await seedDemoSignature(tx, orgId, person.id, signerName)
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
    const specialtyKind = specialtyOfIndex(kind, index)
    if (specialtyKind) {
      const ids = await librarySpecialtyIds(tx, orgId, [specialtyKind])
      const id = ids.get(specialtyKind)
      if (id) await setProfessionalSpecialties(tx, orgId, demo.presenterUserId, person.id, [id])
    }
    team.push({
      userId: person.id,
      name: `${CLINICIAN_HONORIFIC[demo.product][person.sex]} ${signerName}`,
      signerName,
      registration,
      title,
      branchId,
      weekdays,
      afternoonOnly,
      occupancy: Math.min(0.92, kind.occupancy + (random.next() - 0.5) * 0.12),
      specialty: specialtyKind,
    })
  }
  // Las especialidades que atiende el equipo: lo de las demás no se ofrece ni se dice.
  const teamSpecialties = [...new Set(team.flatMap((item) => (item.specialty ? [item.specialty] : [])))]
  const said = await demoTexts(
    tx,
    orgId,
    kind,
    teamSpecialties,
    people.filter((person) => person.role === "clinician").map((person) => person.sex),
  )

  await ensureDefaultPaymentMethods(tx, orgId, demo.presenterUserId, country.code)
  await ensureDefaultPipeline(tx, orgId)
  await upsertAgentConfig(
    tx,
    orgId,
    {
      enabled: true,
      // Clío, donde su producto dicta (en vistIA no dicta).
      clinicalAssistantEnabled: dictationFor(demo.product) !== null,
      personaName: "Sofi",
      treatment: "usted",
      tone: "cercano",
      about: `${kind.name} en ${places[0] ?? country.name}, ${country.name}. Atendemos con cita, de lunes a sábado.`,
    },
    { actorUserId: demo.presenterUserId },
  )
  // Con sus consentimientos activos, como toda clínica nueva.
  await ensureClinicConsents(tx, orgId, demo.presenterUserId)
  // Registro en línea activo, como lo tendría una clínica que presenta: sin él, a quien
  // escribe por primera vez Sofi no puede mandarle su enlace para reservar (ADR 0097).
  await savePatientRegistrationConfig(tx, orgId, demo.presenterUserId, {
    expectedVersion: 0,
    enabled: true,
    fields: { ...DEFAULT_REGISTRATION_CONFIG.fields, docType: "required", docNumber: "required" },
    privacyNotice: `${demo.name} usará tus datos solo para registrarte como paciente, atenderte y recordarte tus citas. Puedes pedir verlos, corregirlos o eliminarlos escribiendo a recepción.`,
  })

  // El canal de la demo no tiene claves de verdad: guarda su historia y, al terminar de
  // armarla, queda desconectado. Meta nunca dijo su calidad ni su límite: no se escriben.
  const connection = await createConnection(
    tx,
    orgId,
    deps.secretsKey,
    {
      channel: "whatsapp",
      provider: "whatsapp_cloud_api",
      displayName: `WhatsApp ${demo.name}`,
      config: {
        phoneNumberId: `demo-${demo.id}`,
        wabaId: `demo-waba-${demo.id}`,
        displayPhoneNumber: DEMO_CLINIC_PHONE,
        accessToken: "demo",
        appSecret: "demo",
      },
    },
    { fetch: deps.fetch, validateExternal: false },
  )
  await seedChannelTemplates(tx, { orgId, connectionId: connection.id })

  // --- El tarifario de la receta, desde la biblioteca del producto ----------------------------
  await step(1, "tarifario")
  const templates = await tx
    .select({ id: treatmentTemplate.id, key: treatmentTemplate.key })
    .from(treatmentTemplate)
    .where(
      and(
        eq(treatmentTemplate.product, demo.product),
        inArray(
          treatmentTemplate.key,
          kind.services.map((item) => item.template),
        ),
      ),
    )
  const templateIdOf = new Map(templates.map((row) => [row.key, row.id]))
  for (const recipe of kind.services) {
    const templateId = templateIdOf.get(recipe.template)
    if (!templateId) continue
    // La consulta de una especialidad que nadie del equipo atiende no se ofrece.
    if (recipe.specialty && !teamSpecialties.includes(recipe.specialty)) continue
    // Una prestación que el país no codifica no se ofrece: se salta sin deshacer las demás.
    await tx
      .transaction(async (inner) => {
        const { created } = await fromTemplates(inner, orgId, demo.presenterUserId, [
          {
            templateId,
            priceCents: demoPriceCents(recipe.price, country),
            durationMin: recipe.durationMin,
          },
          // Como los agrega la pantalla de la biblioteca: «Precio exacto». Sin
          // indicarlo, Sofi decía que la consulta «se define tras una evaluación».
        ], { priceDisclosure: "exacto" })
        // Sus sesiones habituales, como las cambia la clínica en su tarifario.
        if (recipe.usualSessions)
          for (const row of created)
            await updateService(inner, orgId, demo.presenterUserId, row.id, { usualSessions: recipe.usualSessions })
      })
      .catch(() => undefined)
  }
  const services = await demoServices(tx, orgId, kind, teamSpecialties)
  if (!services.some((item) => item.firstVisit))
    throw new ServiceError(
      "CONFLICT",
      409,
      "Falta la biblioteca del producto: ejecuta seed:procedures",
    )
  // Las promociones existen antes de la historia: sus cobros nacen con su precio.
  const operation = {
    orgId,
    ownerUserId: demo.presenterUserId,
    recipe: kind,
    country,
    seed: demo.seed,
  }
  await seedPromotions(tx, operation)

  // --- La historia de los meses que se pidieron -----------------------------------------------
  await step(2, "historia")
  const medications = (await productHooks(tx, orgId)).prescribing.catalog.medications
  await seedReports(tx, {
    orgId,
    ownerUserId: receptionUserId,
    branches: branches.map((item) => ({
      id: item.id,
      roomIds: rooms.get(item.id) ?? [],
      rent: item.rent,
    })),
    professionals: team.map((item) => ({
      userId: item.userId,
      signerName: item.signerName,
      registration: item.registration,
      branchId: item.branchId,
      weekdays: item.weekdays,
      afternoonOnly: item.afternoonOnly,
      occupancy: item.occupancy,
      signerTitle: item.title,
      specialty: item.specialty,
      ...(item.specialty && kind.specialtyWho?.[item.specialty] ? { who: kind.specialtyWho[item.specialty] } : {}),
    })),
    services,
    patientIds: [],
    recipe: {
      months: demo.months,
      seed: demo.seed,
      holidays: country.holidays,
      // Visitas de la historia ≈ meses × 26 días × profesionales × 5 citas: de ahí, cuántas son de alguien nuevo.
      firstVisitShare: Math.min(
        0.24,
        size.patients / (demo.months * 26 * Math.max(1, team.length) * 5),
      ),
      person: (r) => kind.person(r, country),
      note: kind.note,
      diagnosisSystem: "ICD-11",
      inbound: said.inbound,
      reply: said.reply,
      medications,
      budgets: kind.budgets,
      promotions: await demoPromotionsOf(tx, orgId),
      paymentMethods: country.paymentMethods,
      expenses: kind.expenses.map((item) => ({
        ...item,
        ...(item.cents !== undefined ? { cents: demoPriceCents(item.cents / 100, country) } : {}),
        ...(item.perStaffCents !== undefined
          ? { perStaffCents: demoPriceCents(item.perStaffCents / 100, country) }
          : {}),
      })),
      names: {
        given: [...country.given.F, ...country.given.M],
        surnames: country.surnames,
        bySex: country.given,
      },
    },
  })

  // Lo que una visita de la historia ya hizo queda hecho, como en la demo de desarrollo: sin
  // esto el Plan lo daba por no empezado y reservar decía «sesión 2 (1 prevista)» (QA del 8 nov).
  await seedAcceptedProgress(tx, orgId)

  // --- Lo que hicieron los agentes y lo que Argos ya respondió --------------------------------
  await step(3, "agentes")
  // Miles de filas recién escritas: sin sus estadísticas el planificador elige mal y lo que sigue tarda minutos.
  await tx.execute(
    sql`analyze appointment, conversation, message, patient, contact, encounter, patient_charge, patient_payment`,
  )
  await seedReportsAgent(tx, {
    orgId,
    planCode: plan.code,
    months: demo.months,
    // Clío solo dicta donde su producto dicta: una óptica de vistIA no tiene consultas dictadas.
    dictating: dictationFor(demo.product)
      ? team.slice(0, 3).map((item, index) => ({
          userId: item.userId,
          fromMonthsAgo: Math.max(1, Math.min(demo.months, [10, 6, 3][index] ?? 3)),
          share: [0.25, 0.6] as [number, number],
        }))
      : [],
  })
  // Lo que cobra el plan cuenta el mes desde el alta; la demo nunca se factura.
  await tx
    .update(saasSubscription)
    .set({ isDemo: true })
    .where(eq(saasSubscription.organizationId, orgId))
  // Los controles son los de la receta: su nombre, cada cuánto y a quién.
  await seedReportsPatients(tx, { orgId, ownerUserId: receptionUserId, followUp: kind.followUp })
  await seedReportsArgos(tx, {
    orgId,
    ownerUserId: demo.presenterUserId,
    professionalUserId: (team[0] as TeamMember).userId,
  })
  await seedSaasCostDemo(tx, {
    orgId,
    askers: [
      { userId: demo.presenterUserId, weight: 3 },
      ...team.slice(0, 2).map((item) => ({ userId: item.userId, weight: 1 })),
    ],
  })
  // Cada respuesta de Sofi de la historia con su corrida: Agente cuenta lo mismo que Reportes.
  await seedRepliesRuns(tx, orgId)

  // --- Hoy y las próximas dos semanas ---------------------------------------------------------
  await step(4, "hoy")
  const { timezone, currency } = await getOrgLocale(tx, orgId)
  const context: AgendaContext = {
    holidays: country.holidays,
    orgId,
    timezone,
    currency,
    kind: said,
    random,
    receptionUserId,
    team,
    rooms,
    services,
    paymentMethods: country.paymentMethods,
    medications,
  }
  const today = reportDayOf(timezone, now)
  // La historia termina dos días antes de hoy: desde ahí sigue la agenda.
  const historyEnd = now.getTime() - 2 * 86_400_000
  const through = addDays(today, HORIZON_DAYS)
  // Primero los teléfonos: la agenda que viene es de personas a las que se puede escribir.
  await giveDemoPhones(tx, orgId)
  for (let day = addDays(today, -2); day <= through; day = addDays(day, 1))
    await planDay(tx, context, day, historyEnd)
  await closeVisits(tx, context, now)
  await seedTodayInbox(tx, context, connection.id, today, size.professionals, now)
  await topUpFollowUps(tx, context, today, now)

  // --- Lo que el equipo ya usa: inventario, promociones, comisiones, oportunidades y Sofi ----
  // Después de hoy: los materiales se descuentan de las atenciones recién cerradas.
  await step(5, "operacion")
  await seedOperation(tx, operation)
  // Con su historia armada, el WhatsApp de la demo queda desconectado: no tiene un número
  // de verdad, así que no dice «Conectado» ni intenta enviar (la Bandeja lo dice al escribir).
  await setConnectionStatus(tx, orgId, connection.id, "disabled")
  // Lo propio del producto sobre la historia ya armada (vistIA: las recetas de lentes).
  await (await productHooks(tx, orgId)).demoBuilt?.(tx, orgId)
  await step(DEMO_BUILD_STEPS, "listo")
  return { organizationId: orgId, historyThrough: through, slug }
}

async function freeDemoSlug(tx: Db, wanted: string): Promise<string> {
  for (let index = 1; index < 200; index += 1) {
    const slug = index === 1 ? wanted : `${wanted}-${index}`
    const [taken] = await tx.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug)).limit(1)
    if (!taken) return slug
  }
  throw new ServiceError("CONFLICT", 409, "No hay un subdominio libre para esta demo")
}

/**
 * Los servicios de la receta que la clínica ofrece, con su peso en la agenda,
 * su especialidad y a quién se le dan. La consulta de una especialidad que
 * nadie del equipo atiende queda fuera.
 */
async function demoServices(
  tx: Db,
  orgId: string,
  kind: DemoKindRecipe,
  specialties: readonly string[],
): Promise<DemoService[]> {
  const rows = await tx
    .select({
      id: serviceCatalog.id,
      name: serviceCatalog.name,
      priceCents: serviceCatalog.priceCents,
      durationMin: serviceCatalog.durationMin,
      specialtyId: serviceCatalog.specialtyId,
      key: treatmentTemplate.key,
    })
    .from(serviceCatalog)
    .innerJoin(treatmentTemplate, eq(treatmentTemplate.id, serviceCatalog.templateId))
    .where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.isActive, true)))
  // La regla de la agenda de la app (`attendingRule`): un servicio de una especialidad que
  // alguien del equipo atiende lo da solo quien la atiende (la consulta de control y las
  // pruebas son de medicina general); si nadie la atiende, cualquiera.
  const kindOfId = new Map([...(await librarySpecialtyIds(tx, orgId, specialties))].map(([key, id]) => [id, key]))
  const offered = kind.services.flatMap((recipe): DemoService[] => {
    const row = rows.find((item) => item.key === recipe.template)
    if (recipe.specialty && !specialties.includes(recipe.specialty)) return []
    const specialty = (row?.specialtyId ? kindOfId.get(row.specialtyId) : undefined) ?? recipe.specialty
    return row && row.priceCents !== null
      ? [
          {
            id: row.id,
            name: row.name,
            priceCents: row.priceCents,
            durationMin: row.durationMin ?? recipe.durationMin,
            weight: recipe.weight,
            firstVisit: recipe.firstVisit ?? false,
            ...(specialty ? { specialty } : {}),
            ...(recipe.who ? { who: recipe.who } : {}),
            ...(recipe.perUnit ? { perUnit: true } : {}),
          },
        ]
      : []
  })
  // La primera visita es la primera de la receta que el país ofrece (una por cada especialidad
  // que la receta separa); las de respaldo quedan como una más.
  const groupOf = (item: DemoService): string =>
    kind.services.find((recipe) => recipe.firstVisit && rows.some((row) => row.id === item.id && row.key === recipe.template))
      ?.specialty ?? ""
  const firsts = new Map<string, DemoService>()
  for (const item of offered) if (item.firstVisit && !firsts.has(groupOf(item))) firsts.set(groupOf(item), item)
  return offered.map((item) =>
    item.firstVisit && firsts.get(groupOf(item)) !== item
      ? { ...item, firstVisit: false, weight: Math.max(item.weight, 4) }
      : item,
  )
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
  if (weekday === 0 || ctx.holidays.has(day.slice(5))) return
  const end = new Date(start.getTime() + 86_400_000)
  const [existing] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, ctx.orgId),
        gte(appointment.startsAt, start),
        lt(appointment.startsAt, end),
      ),
    )
  if ((existing?.count ?? 0) > 0 && start.getTime() >= notBefore) return
  // Primero quienes tienen un teléfono (el suyo o el de su responsable): a ellos se les confirma la cita.
  const patients = (
    (await tx.execute(sql`
    select p.id, c.birth_date::text as birth_date, c.sex
    from patient p
    join contact c on c.organization_id = p.organization_id and c.id = p.person_id
    left join lateral (
      select gc.phone from patient_contact pc
      join contact gc on gc.organization_id = pc.organization_id and gc.id = pc.contact_id
      where pc.organization_id = p.organization_id and pc.patient_id = p.id and pc.relationship = 'guardian' and pc.is_preferred
      limit 1
    ) g on true
    where p.organization_id = ${ctx.orgId} and c.record_locked_at is null
    order by (coalesce(g.phone, c.phone) is null), md5(p.id::text || ${day}) limit 400`)) as unknown as Array<{
      id: string
      birth_date: string | null
      sex: string | null
    }>
  ).map((row) => ({
    id: row.id,
    person:
      row.birth_date && (row.sex === "F" || row.sex === "M")
        ? { birthDate: row.birth_date.slice(0, 10), sex: row.sex as "F" | "M" }
        : null,
  }))
  if (patients.length === 0) return
  const booked = new Set<string>()
  /** La siguiente persona de la lista que puede recibir el servicio ese día, y que no tiene otra cita ese día. */
  const nextPatient = (need: Array<DemoWho | undefined>, at: Date): string | null => {
    for (let step = 0; step < patients.length; step += 1) {
      const candidate = patients[(cursor + step) % patients.length] as (typeof patients)[number]
      if (booked.has(candidate.id)) continue
      const person = candidate.person
      if (person && (person.birthDate > at.toISOString().slice(0, 10) || !need.every((who) => whoFits(who, person, at))))
        continue
      cursor = (cursor + step + 1) % patients.length
      booked.add(candidate.id)
      return candidate.id
    }
    return null
  }
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
  const free = (key: string, from: number, to: number): boolean =>
    !(busy.get(key) ?? []).some(([a, b]) => from < b && a < to)
  for (const row of await tx
    .select({
      roomId: appointment.roomId,
      professionalUserId: appointment.professionalUserId,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
    })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, ctx.orgId),
        inArray(appointment.status, ["programada", "confirmada"]),
        gte(appointment.startsAt, start),
        lt(appointment.startsAt, end),
      ),
    )) {
    take(`room:${row.roomId}`, row.startsAt.getTime(), row.endsAt.getTime())
    take(`pro:${row.professionalUserId}`, row.startsAt.getTime(), row.endsAt.getTime())
  }
  let cursor = 0
  for (const professional of ctx.team) {
    if (!professional.weekdays.includes(weekday)) continue
    const roomIds = ctx.rooms.get(professional.branchId) ?? []
    const hours = professional.afternoonOnly
      ? AFTERNOON
      : weekday === 6
        ? MORNING
        : [...MORNING, ...AFTERNOON]
    for (const hour of hours) {
      // Quedan horas libres para que Sofi tenga dónde reservar.
      if (!ctx.random.chance(professional.occupancy * (hour >= 15 ? 0.7 : 0.9))) continue
      const startsAt = new Date(
        start.getTime() + hour * 3_600_000 + ctx.random.pick([0, 0, 15]) * 60_000,
      )
      if (startsAt.getTime() < notBefore) continue
      // Solo lo que atiende ese profesional (su especialidad), y a quien le corresponde.
      const mineFirst = first.filter((item) => attends(professional, item))
      const mineFollow = followUps.filter((item) => attends(professional, item))
      const isFirst = ctx.random.chance(0.12) && mineFirst.length > 0
      const choices = isFirst ? mineFirst : mineFollow.length > 0 ? mineFollow : mineFirst
      if (choices.length === 0) continue
      const service = ctx.random.weighted(choices)
      const from = startsAt.getTime()
      const to = from + service.durationMin * 60_000
      const roomId = roomIds.find((id) => free(`room:${id}`, from, to))
      if (!roomId || !free(`pro:${professional.userId}`, from, to)) continue
      const patientId = nextPatient(needOf(ctx.kind, professional, service), startsAt)
      if (!patientId) continue
      take(`room:${roomId}`, from, to)
      take(`pro:${professional.userId}`, from, to)
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
 * cierran las que siguen programadas o confirmadas, y nunca una que salió de
 * una conversación.
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
    .where(
      and(
        eq(appointment.organizationId, ctx.orgId),
        inArray(appointment.status, ["programada", "confirmada"]),
        lt(appointment.endsAt, new Date(before.getTime() - 30 * 60_000)),
        // La que salió de una conversación la reservó alguien de verdad (quien prueba a Sofi por
        // WhatsApp): se queda como esté, para que su llegada o su falta las diga la clínica (ADR 0113).
        sql`${appointment.conversationId} is null`,
        // Si alguien ya abrió su atención en una presentación, la cita es suya: no se toca.
        sql`not exists (select 1 from encounter e where e.organization_id = ${appointment.organizationId} and e.appointment_id = ${appointment.id} and e.voided_at is null)`,
      ),
    )
  if (due.length === 0) return 0
  // Una atención en borrador por persona: la cita de quien ya tiene una queda como está.
  const drafts = new Set(
    (
      await tx
        .select({ patientId: encounter.patientId })
        .from(encounter)
        .where(and(eq(encounter.organizationId, ctx.orgId), eq(encounter.status, "borrador")))
    ).map((row) => row.patientId),
  )
  const tax = chargeTaxOf(await orgTaxes(tx, ctx.orgId), false)
  const promotions = await demoPromotionsOf(tx, ctx.orgId)
  const missed: string[] = []
  const attended: typeof due = []
  for (const visit of due) {
    if (drafts.has(visit.patientId)) continue
    if (ctx.random.chance(0.08)) missed.push(visit.id)
    else attended.push(visit)
  }
  if (missed.length > 0)
    await tx
      .update(appointment)
      .set({ status: "no_asistio" })
      .where(inArray(appointment.id, missed))
  const priceOf = new Map(ctx.services.map((item) => [item.id, item]))
  // Lo cobrado de todas las tandas: se guarda junto, con sus tickets en orden de cobro.
  const payments: SeedPayment[] = []
  const charged = new Map<string, SeedCharge>()
  for (const batch of chunks(attended, 200)) {
    const people = new Map(
      (
        await tx.execute(sql`
          select p.id, c.birth_date::text as birth_date, c.sex from patient p join contact c on c.organization_id = p.organization_id and c.id = p.person_id
          where p.organization_id = ${ctx.orgId} and p.id in (${sql.join(
            batch.map((item) => sql`${item.patientId}::uuid`),
            sql`, `,
          )})`)
      ).map((row) => {
        const value = row as { id: string; birth_date: string | null; sex: "F" | "M" | null }
        return [
          value.id,
          value.birth_date
            ? { birthDate: String(value.birth_date).slice(0, 10), sex: value.sex ?? "F" }
            : null,
        ] as const
      }),
    )
    // Un paciente con dos citas cerradas a la vez: la segunda espera a la próxima noche.
    const seen = new Set<string>()
    const unique = batch.filter((visit) => {
      if (seen.has(visit.patientId)) return false
      seen.add(visit.patientId)
      return true
    })
    const rows = unique.map((visit) => {
      const professional = ctx.team.find((item) => item.userId === visit.professionalUserId)
      const service =
        (visit.serviceId ? priceOf.get(visit.serviceId) : undefined) ?? ctx.services[0]
      const startedAt = new Date(visit.startsAt.getTime() + ctx.random.int(0, 12) * 60_000)
      const endedAt = new Date(startedAt.getTime() + visit.durationMin * 60_000)
      const note = ctx.kind.note(
        { name: visit.serviceName ?? service?.name ?? "" },
        ctx.random,
        people.get(visit.patientId) ?? null,
        startedAt,
      )
      return {
        visit,
        professional,
        service,
        note,
        startedAt,
        endedAt,
        encounterId: randomUUID(),
        procedureId: randomUUID(),
        chargeId: randomUUID(),
        promoted: service ? promotionFor(promotions, service.id, endedAt, ctx.random) : null,
      }
    })
    await tx
      .update(appointment)
      .set({
        status: "atendida",
        arrivedAt: sql`${appointment.startsAt} - interval '5 minutes'`,
        arrivedBy: ctx.receptionUserId,
      })
      .where(
        inArray(
          appointment.id,
          rows.map((row) => row.visit.id),
        ),
      )
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
        // Se abrió al empezar: la Historia la fecha ese día, no el de la noche que la cerró.
        createdAt: row.startedAt,
        signerName: row.professional?.signerName ?? null,
        signerTitle: row.professional?.title ?? null,
        signerRegistration: row.professional?.registration ?? null,
      })),
    )
    const known = await knownDiagnosisCodes(
      tx,
      "ICD-11",
      rows.map((row) => row.note.diagnosisCode),
    )
    const diagnosed = rows.filter(
      (row) => row.note.diagnosisCode && known.has(row.note.diagnosisCode),
    )
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
    if (priced.length > 0)
      await tx.insert(encounterProcedure).values(
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
      from (values ${sql.join(
        rows.map(
          (row) => sql`(${row.encounterId}::uuid, ${row.endedAt.toISOString()}::timestamptz)`,
        ),
        sql`, `,
      )}) as v(id, ended_at)
      where e.organization_id = ${ctx.orgId} and e.id = v.id`)
    // La receta y el descanso que se emitieron en la atención, firmados por quien atendió.
    await insertSeedPapers(tx, {
      orgId: ctx.orgId,
      timezone: ctx.timezone,
      diagnosisSystem: "ICD-11",
      medications: ctx.medications,
      rows: rows.map((row) => ({
        patientId: row.visit.patientId,
        encounterId: row.encounterId,
        endedAt: row.endedAt,
        note: row.note,
        diagnosisCode: row.note.diagnosisCode && known.has(row.note.diagnosisCode) ? row.note.diagnosisCode : null,
        signer: {
          userId: row.visit.professionalUserId,
          name: row.professional?.signerName ?? "",
          title: row.professional?.title ?? null,
          registration: row.professional?.registration ?? null,
        },
      })),
    })
    if (priced.length === 0) continue
    await tx.insert(patientCharge).values(
      priced.map((row) => ({
        id: row.chargeId,
        organizationId: ctx.orgId,
        patientId: row.visit.patientId,
        encounterProcedureId: row.procedureId,
        branchId: row.visit.branchId,
        description: row.service?.name ?? "",
        amountCents: row.promoted?.cents ?? row.service?.priceCents ?? 0,
        currency: ctx.currency,
        ...(tax ?? {}),
        ...(row.promoted?.charge ?? {}),
        createdBy: row.visit.professionalUserId,
        createdAt: row.endedAt,
      })),
    )
    // Casi todo se cobra el mismo día; algunos quedan debiendo (de ahí «Te deben»).
    const paid = priced.filter(() => ctx.random.chance(0.88))
    for (const row of priced) {
      charged.set(row.chargeId, {
        description: row.service?.name ?? "",
        amountCents: row.promoted?.cents ?? row.service?.priceCents ?? 0,
        promotionName: row.promoted?.charge.promotionName ?? null,
        taxCategory: tax?.taxCategory ?? null,
        taxBps: tax?.taxBps ?? null,
      })
    }
    for (const row of paid) {
      const method = ctx.random.weighted(ctx.paymentMethods)
      const cents = row.promoted?.cents ?? row.service?.priceCents ?? 0
      if (cents <= 0) continue
      payments.push({
        patientId: row.visit.patientId,
        branchId: row.visit.branchId,
        chargeId: row.chargeId,
        amountCents: cents,
        taxCents: tax?.taxCategory === "S" ? includedTaxCents(cents, tax.taxBps) : 0,
        currency: ctx.currency,
        paidAt: new Date(row.endedAt.getTime() + 5 * 60_000),
        methodName: method.name,
        methodTypeCode: method.typeCode,
        createdBy: ctx.receptionUserId,
      })
    }
  }
  // Con su ticket y su caja: lo de días anteriores, en el cierre de su día; lo de hoy, en la caja abierta.
  await insertSeedPayments(tx, {
    orgId: ctx.orgId,
    payments,
    charges: charged,
    openFrom: reportDayOf(ctx.timezone, before),
    cashierUserId: ctx.receptionUserId,
  })
  return due.length
}

/**
 * Los teléfonos de quienes escriben (cada paciente o su responsable, y quien
 * solo preguntó): un número del rango de ficción y su identidad de WhatsApp,
 * así su ficha dice el número por el que escribe y se le puede confirmar la
 * cita. Primero a quien escribió el último mes y después a quien vino o
 * escribió más hace poco: el rango tiene 999
 * números y una demo grande tiene más personas; las demás quedan sin
 * teléfono, como una ficha vieja. Sus conversaciones de WhatsApp quedan con ese número.
 */
async function giveDemoPhones(tx: Db, orgId: string): Promise<void> {
  const writers = demoFictionPhones().writers.map((wa) => sql`${wa}`)
  await tx.execute(sql`
    with writers as (
      select coalesce(g.contact_id, p.person_id) as contact_id, max(a.starts_at) as last_visit
      from patient p
      left join patient_contact g on g.organization_id = p.organization_id and g.patient_id = p.id
        and g.relationship = 'guardian' and g.is_preferred
      left join appointment a on a.organization_id = p.organization_id and a.patient_id = p.id
      where p.organization_id = ${orgId}
      group by 1
    ), talkers as (
      select contact_id, max(last_message_at) as last_message from conversation
      where organization_id = ${orgId} group by 1
    ), wanted as (
      select k.id as contact_id,
        row_number() over (
          order by coalesce(t.last_message > now() - interval '30 days', false) desc,
            greatest(w.last_visit, t.last_message) desc nulls last, k.id
        ) as n
      from contact k
      left join writers w on w.contact_id = k.id
      left join talkers t on t.contact_id = k.id
      where k.organization_id = ${orgId} and (w.contact_id is not null or t.contact_id is not null)
        and k.phone is null and k.record_locked_at is null and not k.is_test
        and not exists (select 1 from contact_identity i where i.organization_id = k.organization_id and i.contact_id = k.id and i.channel = 'whatsapp')
    ), free as (
      select f.wa, row_number() over (order by f.position) as n
      from unnest(array[${sql.join(writers, sql`, `)}]::text[]) with ordinality as f(wa, position)
      where not exists (select 1 from contact_identity i where i.organization_id = ${orgId} and i.channel = 'whatsapp'
          and i.external_user_id = f.wa)
        and not exists (select 1 from contact c where c.organization_id = ${orgId} and c.phone = '+' || f.wa)
    ), given as (
      update contact c set phone = '+' || f.wa
      from wanted w join free f on f.n = w.n
      where c.organization_id = ${orgId} and c.id = w.contact_id
      returning c.id, f.wa
    )
    insert into contact_identity (organization_id, contact_id, channel, external_user_id, is_primary)
    select ${orgId}, id, 'whatsapp', wa, true from given`)
  await tx.execute(sql`
    update conversation cv set contact_identity_id = i.id
    from contact_identity i, channel_connection cc
    where cv.organization_id = ${orgId} and cv.contact_identity_id is null
      and i.organization_id = ${orgId} and i.contact_id = cv.contact_id and i.channel = 'whatsapp'
      and cc.organization_id = ${orgId} and cc.id = cv.channel_connection_id and cc.channel = 'whatsapp'`)
}

/**
 * Recepción cierra la caja que quedó abierta de un día anterior: contada, sin
 * diferencia y sin dejar fondo, con la operación de la app. Lo cobrado en una
 * presentación queda en ese cierre, como en una clínica que cierra cada noche.
 */
async function closeDemoCash(tx: Db, ctx: AgendaContext, today: string): Promise<void> {
  const [year, month, date] = today.split("-").map(Number) as [number, number, number]
  const start = dayStart(ctx.timezone, year, month, date)
  const open = await tx
    .select({ id: cashShift.id })
    .from(cashShift)
    .where(and(eq(cashShift.organizationId, ctx.orgId), eq(cashShift.status, "abierta"), lt(cashShift.openedAt, start)))
  for (const shift of open) {
    const counted = (await getShiftDetail(tx, ctx.orgId, shift.id)).esperadoCents
    if (counted < 0) continue
    await closeShift(tx, ctx.orgId, ctx.receptionUserId, shift.id, {
      countedCents: counted,
      retainedCents: 0,
      deliveredCents: counted,
    })
  }
}

/**
 * La Bandeja de hoy: temas que esperan a una persona, conversaciones que
 * atiende Sofi y otras que esperan respuesta del paciente. Si hoy ya tiene las
 * suyas, no agrega otras. Quien ya escribió antes vuelve a su conversación de
 * WhatsApp, que se reabre (ADR 0024): una persona tiene una por su número.
 */
async function seedTodayInbox(
  tx: Db,
  ctx: AgendaContext,
  connectionId: string,
  today: string,
  professionals: number,
  at: Date,
): Promise<void> {
  const thread = `demo-${today}-`
  const [already] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(message)
    .where(and(eq(message.organizationId, ctx.orgId), like(message.externalId, `${thread}%`)))
  if ((already?.count ?? 0) > 0) return
  // Quienes escriben por WhatsApp tienen su número: primero ellos, cada persona una vez.
  // Quien ya tiene una conversación por esta conexión vuelve a ella; si sigue abierta (la
  // atienden todavía), hoy no escribe otra vez.
  const writers = (await tx.execute(sql`
    with writers as (
      select distinct on (coalesce(g.contact_id, p.person_id)) coalesce(g.contact_id, p.person_id) as contact_id,
        md5(p.id::text || ${today}) as shuffle
      from patient p
      left join patient_contact g on g.organization_id = p.organization_id and g.patient_id = p.id
        and g.relationship = 'guardian' and g.is_preferred
      where p.organization_id = ${ctx.orgId}
      order by coalesce(g.contact_id, p.person_id), md5(p.id::text || ${today})
    )
    select w.contact_id, last.id as conversation_id
    from writers w
    join contact k on k.organization_id = ${ctx.orgId} and k.id = w.contact_id and k.record_locked_at is null
    left join lateral (
      select c.id, c.status from conversation c
      where c.organization_id = ${ctx.orgId} and c.channel_connection_id = ${connectionId}::uuid and c.contact_id = w.contact_id
      order by c.last_message_at desc nulls last, c.id limit 1
    ) last on true
    where last.id is null or last.status = 'closed'
    order by not exists (select 1 from contact_identity i where i.organization_id = ${ctx.orgId} and i.contact_id = w.contact_id and i.channel = 'whatsapp'),
      w.shuffle
    limit 60`)) as unknown as Array<{ contact_id: string; conversation_id: string | null }>
  if (writers.length === 0) return
  const now = at.getTime()
  const total = Math.min(writers.length, 4 + professionals * 3)
  const runs: Array<typeof agentRunLedger.$inferInsert> = []
  for (let index = 0; index < total; index += 1) {
    const writer = writers[index] as (typeof writers)[number]
    const contactId = writer.contact_id
    const asked = new Date(now - ctx.random.int(5, 300) * 60_000)
    const answered = new Date(asked.getTime() + ctx.random.int(20, 90) * 1000)
    // La respuesta contesta a lo que preguntó (van de a pares en la receta).
    const exchange = ctx.random.int(0, ctx.kind.inbound.length - 1)
    const topic = index < ctx.kind.openTopics.length ? (ctx.kind.openTopics[index] as string) : null
    const waitsPatient = !topic && index % 3 === 0
    const times = {
      unreadCount: topic ? 1 : 0,
      lastInboundAt: topic ? new Date(answered.getTime() + 60_000) : asked,
      lastOutboundAt: answered,
      lastMessageAt: topic ? new Date(answered.getTime() + 60_000) : answered,
    }
    let conv: { id: string }
    if (writer.conversation_id) {
      // Vuelve a escribir: su conversación se reabre con una atención nueva, como lo hace la app.
      await reopenIfClosed(tx, ctx.orgId, writer.conversation_id, { userId: null, via: "entrante" })
      await tx
        .update(conversation)
        .set({ ...times, attentionStartedAt: asked, updatedAt: asked })
        .where(and(eq(conversation.organizationId, ctx.orgId), eq(conversation.id, writer.conversation_id)))
      conv = { id: writer.conversation_id }
    } else {
      conv = await seedConversationIn(tx, { orgId: ctx.orgId, contactId, connectionId, thread: `${thread}${index}`, ...times })
    }
    const first = await seedMessageIn(tx, {
      orgId: ctx.orgId,
      conversationId: conv.id,
      direction: "in",
      senderKind: "contact",
      body: ctx.kind.inbound[exchange] as string,
      externalId: `${thread}${index}-a`,
      status: "received",
      createdAt: asked,
    })
    await seedMessageIn(tx, {
      orgId: ctx.orgId,
      conversationId: conv.id,
      direction: "out",
      senderKind: "agent",
      body: ctx.kind.reply[exchange] ?? ctx.random.pick(ctx.kind.reply),
      externalId: `${thread}${index}-b`,
      status: waitsPatient ? "read" : "delivered",
      createdAt: answered,
    })
    // Cada respuesta de Sofi es una corrida suya, y pasar el tema al equipo, otra: así
    // Agente cuenta lo mismo que Reportes.
    runs.push({
      organizationId: ctx.orgId,
      conversationId: conv.id,
      triggerMessageId: first.id,
      model: "gpt-6-luna",
      status: "ok",
      startedAt: new Date(asked.getTime() + 1_000),
      endedAt: answered,
      latencyMs: Math.max(0, answered.getTime() - asked.getTime() - 1_000),
      toolsUsed: ["send_reply"],
    })
    if (topic) {
      const askedAgain = new Date(answered.getTime() + 60_000)
      const question = await seedMessageIn(tx, {
        orgId: ctx.orgId,
        conversationId: conv.id,
        direction: "in",
        senderKind: "contact",
        body: topic,
        externalId: `${thread}${index}-c`,
        status: "received",
        createdAt: askedAgain,
      })
      await createHandoff(tx, ctx.orgId, null, {
        conversationId: conv.id,
        reason: topic,
        summary: `Escribió: «${topic}»`,
        priority: "media",
        createdBy: "agent",
        sourceMessageId: question.id,
      })
      runs.push({
        organizationId: ctx.orgId,
        conversationId: conv.id,
        triggerMessageId: question.id,
        model: "gpt-6-luna",
        status: "handoff",
        startedAt: new Date(askedAgain.getTime() + 1_000),
        endedAt: new Date(askedAgain.getTime() + 5_000),
        latencyMs: 4_000,
        toolsUsed: ["request_human_handoff"],
      })
    }
  }
  if (runs.length > 0) await tx.insert(agentRunLedger).values(runs)
}

/**
 * Un control que ya no corresponde se cancela: el prenatal de una gestación
 * que ya terminó. La receta dice hasta cuántos meses vale después de la
 * atención que lo pidió; uno más y se cancela con su motivo.
 */
async function expireFollowUps(tx: Db, ctx: AgendaContext, at: Date): Promise<void> {
  const followUp = ctx.kind.followUp
  if (!followUp?.validMonths) return
  await tx.execute(sql`
    update clinical_follow_up f set status = 'cancelado', cancelled_reason = ${followUp.expired ?? "Ya no corresponde"},
      cancelled_at = ${at.toISOString()}::timestamptz, updated_at = ${at.toISOString()}::timestamptz
    from encounter e
    where f.organization_id = ${ctx.orgId} and f.status = 'pendiente' and f.title = ${followUp.title}
      and e.organization_id = f.organization_id and e.id = f.origin_encounter_id
      and e.ended_at < ${at.toISOString()}::timestamptz - make_interval(months => ${followUp.validMonths + 1})`)
}

/**
 * Los controles que vencen este mes (la receta dice cuál y cada cuánto): así
 * «Controles» y Sofi tienen a quién avisar. Solo agrega lo que falta, y solo de
 * atenciones recientes si la receta dice hasta cuándo vale.
 */
async function topUpFollowUps(tx: Db, ctx: AgendaContext, today: string, at: Date): Promise<void> {
  const followUp = ctx.kind.followUp
  if (!followUp) return
  const [year, month] = today.split("-").map(Number) as [number, number]
  const monthStart = dayStart(ctx.timezone, year, month, 1)
  const [open] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(clinicalFollowUp)
    .where(
      and(
        eq(clinicalFollowUp.organizationId, ctx.orgId),
        eq(clinicalFollowUp.status, "pendiente"),
        gte(clinicalFollowUp.dueAt, monthStart),
      ),
    )
  const wanted = 8 + ctx.team.length * 4
  const missing = wanted - (open?.count ?? 0)
  if (missing <= 0) return
  // El control es de quien lo necesita: con los diagnósticos de la receta, solo después de una atención con uno de ellos.
  const diagnoses = followUp.diagnoses ?? []
  const origins = (await tx.execute(sql`
    select distinct on (e.patient_id) e.id, e.patient_id, e.professional_user_id
    from encounter e
    where e.organization_id = ${ctx.orgId} and e.status = 'finalizada'
      and not exists (select 1 from clinical_follow_up f where f.organization_id = e.organization_id and f.patient_id = e.patient_id and f.status = 'pendiente')
      ${
        diagnoses.length > 0
          ? sql`and exists (select 1 from encounter_diagnosis d where d.organization_id = e.organization_id and d.encounter_id = e.id
              and d.diagnosis_code in (${sql.join(
                diagnoses.map((code) => sql`${code}`),
                sql`, `,
              )}))`
          : sql``
      }
      ${
        followUp.validMonths
          ? sql`and e.ended_at > ${at.toISOString()}::timestamptz - make_interval(months => ${followUp.validMonths})`
          : sql``
      }
    order by e.patient_id, e.ended_at desc
    limit ${missing}`)) as unknown as Array<{
    id: string
    patient_id: string
    professional_user_id: string
  }>
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
async function agendaContextOf(
  tx: Db,
  demo: DemoRecipeRef,
  orgId: string,
  today: string,
): Promise<AgendaContext> {
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
  for (const row of (await tx.execute(
    sql`select branch_id, id from schedule_room where organization_id = ${orgId} order by name`,
  )) as unknown as Array<{ branch_id: string; id: string }>)
    rooms.set(row.branch_id, [...(rooms.get(row.branch_id) ?? []), row.id])
  // La especialidad de cada profesional, como la dejó el armado (la de la receta que atiende).
  const kinds = [
    ...new Set([...(kind.specialtyRotation ?? []), ...(kind.professional.specialty ? [kind.professional.specialty] : [])]),
  ]
  const kindOfId = new Map([...(await librarySpecialtyIds(tx, orgId, kinds))].map(([key, id]) => [id, key]))
  const specialtyOf = new Map<string, string>()
  for (const row of await tx
    .select({ userId: professionalSpecialty.userId, specialtyId: professionalSpecialty.specialtyId })
    .from(professionalSpecialty)
    .where(eq(professionalSpecialty.organizationId, orgId))) {
    const key = kindOfId.get(row.specialtyId)
    if (key && !specialtyOf.has(row.userId)) specialtyOf.set(row.userId, key)
  }
  const team: TeamMember[] = schedules.map((row) => ({
    userId: row.professional_user_id,
    name: row.signature_name ?? "",
    signerName: row.signature_name ?? "",
    registration: row.registration_number ?? "",
    title: row.professional_title ?? "",
    branchId: row.branch_id,
    weekdays: row.weekdays.map(Number),
    afternoonOnly: Number(row.first_min) >= 14 * 60,
    occupancy: kind.occupancy,
    specialty: specialtyOf.get(row.professional_user_id) ?? kind.professional.specialty,
  }))
  const specialties = [...new Set(team.flatMap((item) => (item.specialty ? [item.specialty] : [])))]
  return {
    orgId,
    timezone,
    currency,
    // El título de cada profesional dice si es doctora o doctor.
    kind: await demoTexts(
      tx,
      orgId,
      kind,
      specialties,
      schedules.map((row) => (row.professional_title === kind.professional.title.F ? "F" : "M")),
    ),
    // La noche de cada día da su propia agenda, siempre la misma para ese día.
    random: generator((demo.seed ^ Number(today.replaceAll("-", ""))) >>> 0),
    receptionUserId: `${demoUserPrefix(demo.id)}recepcion`,
    team,
    rooms,
    services: await demoServices(tx, orgId, kind, specialties),
    paymentMethods: demoCountryOf(demo.countryCode).paymentMethods,
    holidays: demoCountryOf(demo.countryCode).holidays,
    medications: (await productHooks(tx, orgId)).prescribing.catalog.medications,
  }
}

/**
 * Pone la demo al día (cada noche, decisión 5): cierra lo que pasó, llena los
 * días que entran en las dos semanas, cierra las conversaciones viejas y deja
 * la Bandeja y los controles de hoy. Es idempotente para un mismo día. `now`
 * es la hora de esa noche (las pruebas recorren varias noches seguidas).
 */
export async function advanceDemo(
  tx: Db,
  demo: DemoRecipeRef & { organizationId: string; historyThrough: string | null },
  now: Date = new Date(),
): Promise<{ historyThrough: string; today: string }> {
  const { timezone } = await getOrgLocale(tx, demo.organizationId)
  const today = reportDayOf(timezone, now)
  const at = now.toISOString()
  const ctx = await agendaContextOf(tx, demo, demo.organizationId, today)
  await closeVisits(tx, ctx, now)
  // Lo que el producto agrega a lo cerrado anoche (vistIA: la receta de cada examen firmado).
  await (await productHooks(tx, demo.organizationId)).demoBuilt?.(tx, demo.organizationId, now)
  // Lo cobrado de ayer ya está en su caja: recepción la cierra.
  await closeDemoCash(tx, ctx, today)
  const through = addDays(today, HORIZON_DAYS)
  const from =
    demo.historyThrough && demo.historyThrough >= today ? addDays(demo.historyThrough, 1) : today
  for (let day = from; day <= through; day = addDays(day, 1))
    await planDay(tx, ctx, day, now.getTime())
  // Lo de días anteriores ya se resolvió: la Bandeja queda con lo de hoy.
  await tx.execute(sql`
    update conversation set status = 'closed', closed_at = ${at}::timestamptz, close_reason = 'resuelta', unread_count = 0
    where organization_id = ${demo.organizationId} and status <> 'closed' and last_message_at < ${at}::timestamptz - interval '36 hours'`)
  // Un tema se resuelve con su tarea (`resolveTopic`).
  await tx.execute(sql`
    update task set status = 'done', updated_at = ${at}::timestamptz
    where organization_id = ${demo.organizationId} and status = 'open'
      and id in (select task_id from agent_handoff where organization_id = ${demo.organizationId} and task_id is not null and created_at < ${at}::timestamptz - interval '36 hours')`)
  const [connection] = await tx
    .select({ id: channelConnection.id })
    .from(channelConnection)
    .where(eq(channelConnection.organizationId, demo.organizationId))
    .limit(1)
  if (connection) await seedTodayInbox(tx, ctx, connection.id, today, ctx.team.length, now)
  await expireFollowUps(tx, ctx, now)
  await topUpFollowUps(tx, ctx, today, now)
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
export async function purgeDemoOrganization(
  tx: Db,
  demoId: string,
  orgId: string,
): Promise<DemoPurgeResult> {
  const [owned] = await tx
    .select({ id: saasDemo.id })
    .from(saasDemo)
    .where(and(eq(saasDemo.id, demoId), eq(saasDemo.organizationId, orgId)))
    .limit(1)
  if (!owned) throw new ServiceError("NOT_FOUND", 404, "Esa clínica no es una demo")
  const [role] = (await tx.execute(
    sql`select rolsuper from pg_roles where rolname = current_user`,
  )) as unknown as Array<{ rolsuper: boolean }>
  if (!role?.rolsuper)
    throw new ServiceError("CONFLICT", 409, "Borrar una demo necesita la conexión owner del worker")
  const documents = await tx
    .select({ key: patientDocument.storageKey })
    .from(patientDocument)
    .where(and(eq(patientDocument.organizationId, orgId), isNotNull(patientDocument.storageKey)))
  const attachments = await tx
    .select({ attachments: message.attachments })
    .from(message)
    .where(eq(message.organizationId, orgId))
  // Lo que se subió en una presentación: tomografías, fotos, miniaturas, soporte y comprobantes.
  const files = (await tx.execute(sql`
    select storage_key as key from imaging_study_file where organization_id = ${orgId}
    union all select storage_key from issued_paper where organization_id = ${orgId}
    union all select thumbnail_key from imaging_study where organization_id = ${orgId}
    union all select thumbnail_key from patient_document where organization_id = ${orgId}
    union all select avatar_storage_key from patient where organization_id = ${orgId}
    union all select object_key from support_attachment where organization_id = ${orgId}
    union all select receipt_object_key from saas_payment where organization_id = ${orgId}
    union all select pdf_key from clinic_letterhead where organization_id = ${orgId}`)) as unknown as Array<{ key: string | null }>
  const storageKeys = [
    ...documents.map((row) => row.key),
    ...files.map((row) => row.key),
    ...attachments.flatMap((row) =>
      Array.isArray(row.attachments)
        ? row.attachments.flatMap((item) =>
            item &&
            typeof item === "object" &&
            "objectKey" in item &&
            typeof item.objectKey === "string"
              ? [item.objectKey]
              : [],
          )
        : [],
    ),
  ].filter((key): key is string => Boolean(key))
  const tables = (await tx.execute(sql`
    select c.table_schema, c.table_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.column_name = 'organization_id' and t.table_type = 'BASE TABLE'
      and c.table_schema not in ('admin', 'pg_catalog', 'information_schema')`)) as unknown as Array<{
    table_schema: string
    table_name: string
  }>
  await tx.execute(sql`set local session_replication_role = replica`)
  for (const table of tables) {
    await tx.execute(
      sql`delete from ${sql.identifier(table.table_schema)}.${sql.identifier(table.table_name)} where organization_id = ${orgId}`,
    )
  }
  // De la administración solo lo que es de la clínica; su registro de auditoría queda.
  for (const table of [
    "saas_commission_settlement_line",
    "saas_commission_adjustment",
    "saas_seller_commission",
    "saas_negotiation",
  ])
    await tx.execute(
      sql`delete from admin.${sql.identifier(table)} where organization_id = ${orgId}`,
    )
  await tx.execute(
    sql`update admin.saas_waitlist_request set organization_id = null where organization_id = ${orgId}`,
  )
  // La fila de la demo no se toca aquí: mientras se vuelve a armar, el avance la
  // escribe por otra conexión, y bloquearla en esta transacción la dejaría
  // esperando hasta el final. Quien llama la borra (borrar) o le pone la
  // clínica nueva (volver a empezar) antes de confirmar.
  await tx.delete(organization).where(eq(organization.id, orgId))
  await tx.execute(sql`set local session_replication_role = origin`)
  // El equipo inventado se va con su clínica; si algo lo nombra todavía, la base lo dice aquí.
  await tx.delete(user).where(like(user.id, `${demoUserPrefix(demoId)}%`))
  return { storageKeys }
}
