/**
 * Semilla manual de facturación SaaS.
 *
 * Solo manual (seed-dev la invoca dentro de su tx owner al final, después de
 * seedAdminCore); NUNCA en CI ni importada por tests. Idempotente: inserta
 * con onConflictDoNothing y salta lo ya creado (nunca reescribe configuración
 * editada por un humano). Solo datos demo identificables (ficticio/demo en
 * códigos y nombres; sin datos bancarios reales): en producción los planes y
 * métodos los configura administración. No toca las orgs semilla existentes
 * (`seed-org-dental-smile`, `seed-org-clinica-norte`), no envía correos ni
 * activa automatizaciones.
 */
import { isClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import { member, organization, user } from "@odentia/db/schema/auth"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { processingAgreementAcceptance } from "@odentia/db/schema/workspace"
import {
  type SaasWaitlistStatus,
  saasAction,
  saasCharge,
  saasCommercialTerms,
  saasFollowUp,
  saasPayment,
  saasPaymentMethod,
  saasPlan,
  saasSubscription,
  saasWaitlistRequest,
} from "@odentia/db/schema/saas-billing"
import { and, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { clientForWaitlistRequest, linkClientToOrganization } from "./admin-clients.js"
import type { AdminActor } from "./admin-core.js"
import { decide } from "./admin-sales.js"
import { addDays as addCivilDays, dayStart, reportDayOf } from "./report-periods.js"
import {
  confirmSaasPayment,
  createSaasCharge,
  monthEndUTC,
  monthKeyUTC,
  monthStartUTC,
  rejectSaasReceipt,
  settleSaasCommissions,
  startSaasTrial,
  submitSaasReceipt,
  upsertSaasSeller,
} from "./saas-billing.js"
import { SAAS_TERMS_INITIAL } from "./saas-commercial-terms.js"
import { FOUNDER_INVITATION_DAYS, invitationTokenHash } from "./saas-founders.js"
import { SEED_STAFF_ADMIN_ID, SEED_STAFF_SUPPORT_ID } from "./seed-admin-core.js"
import type { Storage } from "./storage.js"

/**
 * Planes de tamaños de la semilla anterior a la ADR 0031 (un solo plan, sin
 * topes de sedes ni cuentas): se apagan en las bases ya sembradas para que la
 * clínica vea solo el plan de hoy (darvin2c/odentIA#104). Son códigos de la
 * semilla, no configuración de una persona.
 */
const RETIRED_PLAN_CODES = ["ejemplo-ficticio-base", "ejemplo-ficticio-plus", "ejemplo-ficticio-base-usd"]

const FICTIONAL_METHODS = [
  {
    code: "transferencia-ficticia",
    name: "Transferencia (ficticia)",
    instructions: "Ejemplo ficticio: aquí administración escribiría cómo pagar.",
    sortOrder: 1,
  },
  {
    code: "billetera-ficticia",
    name: "Billetera (ficticia)",
    instructions: "Ejemplo ficticio: aquí administración escribiría cómo pagar.",
    sortOrder: 2,
  },
] as const

/** Los precios por tipo de las ADR 0085 y 0105, por un factor (Fundadores: la mitad). */
function tierPlan(factor: number) {
  const price = (usd: number) => Math.round(usd * factor * 1_000_000)
  return {
    conversationInformMicros: price(0.2),
    // Cada Informa cubre hasta 25 mensajes de la persona; por ahora solo se mide (ADR 0105).
    informMessageLimit: 25,
    conversationMicros: price(0.5),
    conversationAgendaMicros: price(1),
    consultationSimpleMicros: price(0.1),
    consultationStandardMicros: price(0.3),
    consultationMicros: price(0.5),
    recoveryMicros: price(2),
    argosIncludedQuestions: 100,
    argosPackQuestions: 100,
    argosPackMicros: price(3),
    storageIncludedGb: 20,
    storageGbMicros: price(0.2),
    // Solo se negocian Gestiona, Agenda, Completa y la cita recuperada (ADR 0085).
    fixedPriceTiers: ["informa", "simple", "estandar", "preguntas", "almacenamiento"],
  }
}

/** Los precios de un plan de la semilla anterior a la ADR 0085: se ponen al día si nadie los cambió. */
const PRE_TIER_PRICES: Record<string, { conversationMicros: number; consultationMicros: number; recoveryMicros: number }> = {
  "odentia-ficticio": { conversationMicros: 500_000, consultationMicros: 400_000, recoveryMicros: 4_000_000 },
  "fundadores-ficticio": { conversationMicros: 300_000, consultationMicros: 240_000, recoveryMicros: 2_400_000 },
}

/** La prueba de todos los planes: USD 100 por 30 días, que la administración amplía hasta 150 y 60 días. */
const TRIAL = { trialCreditCents: 10000, trialDays: 30, trialMaxCreditCents: 15000, trialMaxDays: 60 } as const

/**
 * El plan de las ADR 0031, 0085 y 0105 para probar el cobro por acción: USD 29 que
 * vuelven en crédito, el precio de cada tipo (Sofi 0,20 / 0,50 / 1,00, Clío
 * 0,10 / 0,30 / 0,50, cita recuperada 2), 100 preguntas a Argos y paquetes de
 * 100 por 3, 20 GB y 0,20 por GB extra, y la prueba. Es el plan por defecto de
 * la semilla; en producción lo configura administración.
 */
const ACTION_PLAN = {
  code: "odentia-ficticio",
  name: "Plan odentIA (ficticio)",
  description: "Ejemplo ficticio del cobro por acción; no contratar.",
  currency: "USD",
  priceCents: 2900,
  billingPeriod: "mensual",
  sortOrder: 0,
  creditCents: 2900,
  ...tierPlan(1),
  maxDiscountBps: 6000,
  sellerDiscountBps: 1000,
  ...TRIAL,
  isDefault: true,
  showOnWeb: true,
} as const

/**
 * El plan por invitación de Fundadores (issue 165, ADR 0085): sin cuota, la
 * misma prueba de regalo, todo con 50 % menos, 20 lugares y 12 meses
 * garantizados; sin negociación encima. Se publica en la web.
 */
const FOUNDERS_PLAN = {
  code: "fundadores-ficticio",
  name: "Fundadores (ficticio)",
  description: "Ejemplo ficticio del plan por invitación; no contratar.",
  currency: "USD",
  priceCents: 0,
  billingPeriod: "mensual",
  sortOrder: 0,
  creditCents: 0,
  ...tierPlan(0.5),
  maxDiscountBps: 0,
  sellerDiscountBps: 0,
  ...TRIAL,
  seatLimit: 20,
  guaranteeMonths: 12,
  showOnWeb: true,
} as const

/**
 * La lista de latidIA (ADR 0093): una copia exacta de la de odentIA, con su
 * propio plan por defecto y sus propios 20 lugares de Fundadores.
 */
const MEDICAL_ACTION_PLAN = {
  ...ACTION_PLAN,
  code: "latidia-ficticio",
  name: "Plan latidIA (ficticio)",
  product: "medical",
} as const
const MEDICAL_FOUNDERS_PLAN = {
  ...FOUNDERS_PLAN,
  code: "fundadores-latidia-ficticio",
  name: "Fundadores latidIA (ficticio)",
  product: "medical",
} as const

/**
 * La lista de vistIA: empieza con los precios de latidIA, que son los de odentIA
 * (decisión 3 del plan de vistIA), con su plan por defecto y sus 20 lugares.
 */
const OPTICAL_ACTION_PLAN = {
  ...ACTION_PLAN,
  code: "vistia-ficticio",
  name: "Plan vistIA (ficticio)",
  product: "optical",
} as const
const OPTICAL_FOUNDERS_PLAN = {
  ...FOUNDERS_PLAN,
  code: "fundadores-vistia-ficticio",
  name: "Fundadores vistIA (ficticio)",
  product: "optical",
} as const

/** Los planes de lista y por invitación de cada producto. */
const PRODUCT_PLANS = [
  ACTION_PLAN,
  FOUNDERS_PLAN,
  MEDICAL_ACTION_PLAN,
  MEDICAL_FOUNDERS_PLAN,
  OPTICAL_ACTION_PLAN,
  OPTICAL_FOUNDERS_PLAN,
] as const

/** Catálogo ficticio (no pisa lo editado: solo inserta lo ausente). */
export async function seedSaasBilling(db: Db): Promise<{ plans: number; methods: number }> {
  for (const plan of PRODUCT_PLANS) {
    await db.insert(saasPlan).values(plan).onConflictDoNothing({ target: saasPlan.code })
  }
  // Una base de antes de los tipos (ADR 0085): pone sus precios solo si siguen siendo los de la semilla.
  for (const plan of [ACTION_PLAN, FOUNDERS_PLAN]) {
    const before = PRE_TIER_PRICES[plan.code]
    if (!before) continue
    await db
      .update(saasPlan)
      .set({ ...plan, updatedAt: new Date() })
      .where(
        and(
          eq(saasPlan.code, plan.code),
          isNull(saasPlan.conversationInformMicros),
          eq(saasPlan.conversationMicros, before.conversationMicros),
          eq(saasPlan.consultationMicros, before.consultationMicros),
          eq(saasPlan.recoveryMicros, before.recoveryMicros),
        ),
      )
  }
  // Informa a USD 0,20 (Fundadores 0,10) y su tope en sombra (ADR 0105): una base sembrada antes
  // los pone solo si el plan sigue con el precio anterior de la semilla, la mitad del de hoy.
  for (const plan of PRODUCT_PLANS) {
    await db
      .update(saasPlan)
      .set({ conversationInformMicros: plan.conversationInformMicros, informMessageLimit: plan.informMessageLimit, updatedAt: new Date() })
      .where(and(eq(saasPlan.code, plan.code), eq(saasPlan.conversationInformMicros, plan.conversationInformMicros / 2)))
  }
  // 100 preguntas a Argos al mes (ADR 0085): una base sembrada antes baja de 300 solo si nadie las cambió.
  for (const plan of PRODUCT_PLANS) {
    await db
      .update(saasPlan)
      .set({ argosIncludedQuestions: plan.argosIncludedQuestions, updatedAt: new Date() })
      .where(and(eq(saasPlan.code, plan.code), eq(saasPlan.argosIncludedQuestions, 300)))
  }
  // Estándar a USD 0,30 (Fundadores 0,15): sube solo si seguía en el 0,20 (0,10) anterior de la semilla.
  for (const plan of PRODUCT_PLANS) {
    await db
      .update(saasPlan)
      .set({ consultationStandardMicros: plan.consultationStandardMicros, updatedAt: new Date() })
      .where(and(eq(saasPlan.code, plan.code), eq(saasPlan.consultationStandardMicros, (plan.consultationStandardMicros * 2) / 3)))
  }
  // La prueba igual en los seis: cambia solo si seguía con la anterior de la semilla
  // (la lista ampliable hasta 130; Fundadores por 90 días, sin ampliar).
  await db
    .update(saasPlan)
    .set({ ...TRIAL, updatedAt: new Date() })
    .where(
      or(
        and(
          inArray(saasPlan.code, [ACTION_PLAN.code, MEDICAL_ACTION_PLAN.code, OPTICAL_ACTION_PLAN.code]),
          eq(saasPlan.trialMaxCreditCents, 13000),
        ),
        and(
          inArray(saasPlan.code, [FOUNDERS_PLAN.code, MEDICAL_FOUNDERS_PLAN.code, OPTICAL_FOUNDERS_PLAN.code]),
          eq(saasPlan.trialDays, 90),
          eq(saasPlan.trialMaxDays, 90),
        ),
      ),
    )
  await db.update(saasPlan).set({ isActive: false }).where(inArray(saasPlan.code, RETIRED_PLAN_CODES))
  // Las condiciones comerciales con los valores de hoy (ADR 0074): la migración
  // 0051 ya deja la primera versión; esto solo la repone en una base sin ella.
  const [terms] = await db.select({ id: saasCommercialTerms.id }).from(saasCommercialTerms).limit(1)
  if (!terms) await db.insert(saasCommercialTerms).values({ ...SAAS_TERMS_INITIAL, effectiveFrom: new Date(0) })
  for (const method of FICTIONAL_METHODS) {
    await db
      .insert(saasPaymentMethod)
      .values({
        code: method.code,
        name: method.name,
        instructions: method.instructions,
        sortOrder: method.sortOrder,
      })
      .onConflictDoNothing({ target: saasPaymentMethod.code })
  }
  return { plans: 4, methods: FICTIONAL_METHODS.length }
}

const DEMO_ACTOR = "seed-saas-demo"
const DEMO_SELLER_USER = "seed-saas-demo-seller"
const DAY = 86_400_000
const HOUR = 3_600_000

/** PNG 1x1 real para el comprobante demo (pasa la verificación por bytes). */
const DEMO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

async function ensureDemoOrg(db: Db, id: string, name: string, slug: string): Promise<void> {
  await db
    .insert(organization)
    .values({ id, name, slug, createdAt: new Date() })
    .onConflictDoNothing({ target: organization.id })
}

/**
 * Una clínica de la semilla que ya terminó su alta: con su perfil y sus sedes,
 * así no cuenta en «Altas por completar» (sin perfil o sin sede). Pone solo lo
 * que falta: una base sembrada antes, con la clínica sin perfil ni sede, los
 * recibe en la corrida siguiente, y lo que alguien editó no se toca.
 */
async function ensureFinishedSignupOrg(
  db: Db,
  clinic: { id: string; name: string; slug: string; branches: readonly string[] },
): Promise<void> {
  await ensureDemoOrg(db, clinic.id, clinic.name, clinic.slug)
  await db
    .insert(orgProfile)
    .values({
      organizationId: clinic.id,
      legalName: `${clinic.name} S.A.C.`,
      tradeName: clinic.name,
      countryCode: "PE",
      currency: "PEN",
      locale: "es-PE",
      timezone: "America/Lima",
      diagnosisSystem: "ICD-10",
    })
    .onConflictDoNothing({ target: orgProfile.organizationId })
  const [anyBranch] = await db
    .select({ id: branch.id })
    .from(branch)
    .where(eq(branch.organizationId, clinic.id))
    .limit(1)
  if (!anyBranch) await db.insert(branch).values(clinic.branches.map((name) => ({ organizationId: clinic.id, name })))
}

/**
 * Clínicas ficticias con estados representativos para probar la UI admin
 * (tablero, pendientes, comisiones, liquidaciones): una en prueba, una con
 * comprobante pendiente y una con cobro confirmado, comisión y liquidación.
 * Sin correos ni automatizaciones.
 */
export async function seedSaasBillingDemo(
  db: Db,
  storage: Pick<Storage, "putAttachment">,
): Promise<{ orgs: string[] }> {
  await seedSaasBilling(db)
  await db
    .insert(user)
    .values({ id: DEMO_ACTOR, name: "Demo SaaS (ficticio)", email: "saas-demo@example.test" })
    .onConflictDoNothing({ target: user.id })
  await db
    .insert(user)
    .values({
      id: DEMO_SELLER_USER,
      name: "Vendedor Demo (ficticio)",
      email: "saas-vendedor@example.test",
    })
    .onConflictDoNothing({ target: user.id })
  const seller = await upsertSaasSeller(db, DEMO_ACTOR, {
    userId: DEMO_SELLER_USER,
    displayName: "Vendedor Demo (ficticio)",
    rateBps: 1000,
    windowDays: 90,
  })
  const now = new Date()
  const monthKey = monthKeyUTC(now)

  await ensureDemoOrg(db, "seed-saas-prueba", "Demo Prueba (ficticia)", "saas-demo-prueba")
  await startSaasTrial(db, "seed-saas-prueba", { planCode: ACTION_PLAN.code }, now)

  // Las dos que pagan ya terminaron su alta: la que sigue incompleta es «Demo Prueba», con la
  // propietaria sin aceptar (`seed-admin-organizations.ts`).
  await ensureFinishedSignupOrg(db, { id: "seed-saas-deuda", name: "Demo Deuda (ficticia)", slug: "saas-demo-deuda", branches: ["Sede Principal"] })
  await startSaasTrial(
    db,
    "seed-saas-deuda",
    { planCode: ACTION_PLAN.code, sellerId: seller.id, billingStart: "now" },
    now,
  )
  // El comprobante pendiente demo.png es el que rechaza la QA. Si ya lo rechazó, la semilla
  // vuelve a dejar uno en el cargo del mes que sigue sin pagar, sin abrir otro cargo.
  const dueCharge = await db
    .select({ id: saasPayment.id })
    .from(saasPayment)
    .where(
      and(eq(saasPayment.organizationId, "seed-saas-deuda"), eq(saasPayment.status, "pendiente")),
    )
    .limit(1)
  if (dueCharge.length === 0) {
    const [open] = await db
      .select({ id: saasCharge.id, amountCents: saasCharge.amountCents, paidCents: saasCharge.paidCents })
      .from(saasCharge)
      .where(
        and(
          eq(saasCharge.organizationId, "seed-saas-deuda"),
          eq(saasCharge.periodStart, monthStartUTC(now)),
          inArray(saasCharge.status, ["pendiente", "parcial"]),
          isNull(saasCharge.voidedAt),
        ),
      )
      .orderBy(desc(saasCharge.createdAt))
      .limit(1)
    const charge =
      open ??
      (await createSaasCharge(db, "seed-saas-deuda", DEMO_ACTOR, {
        planCode: ACTION_PLAN.code,
        periodStart: monthStartUTC(now),
        periodEnd: monthEndUTC(now),
      }))
    const [earlier] = await db
      .select({ total: count() })
      .from(saasPayment)
      .where(and(eq(saasPayment.organizationId, "seed-saas-deuda"), eq(saasPayment.chargeId, charge.id)))
    const tries = earlier?.total ?? 0
    await submitSaasReceipt(
      db,
      { storage },
      "seed-saas-deuda",
      DEMO_ACTOR,
      {
        chargeId: charge.id,
        methodCode: "transferencia-ficticia",
        amountCents: charge.amountCents - charge.paidCents,
        receipt: {
          bytes: new Uint8Array(DEMO_PNG),
          contentType: "image/png",
          filename: "demo.png",
        },
        // La clave del primero no cambia: con ella, volver a sembrar no repite el comprobante.
        idempotencyKey: tries === 0 ? `demo-deuda-${monthKey}` : `demo-deuda-${monthKey}-${tries + 1}`,
      },
      now,
    )
  }

  await ensureFinishedSignupOrg(db, { id: "seed-saas-cobrada", name: "Demo Cobrada (ficticia)", slug: "saas-demo-cobrada", branches: ["Sede Principal"] })
  await startSaasTrial(
    db,
    "seed-saas-cobrada",
    { planCode: ACTION_PLAN.code, sellerId: seller.id, billingStart: "now" },
    now,
  )
  const paidCharge = await db
    .select({ id: saasPayment.id })
    .from(saasPayment)
    .where(
      and(
        eq(saasPayment.organizationId, "seed-saas-cobrada"),
        eq(saasPayment.status, "confirmado"),
      ),
    )
    .limit(1)
  if (paidCharge.length === 0) {
    const charge = await createSaasCharge(db, "seed-saas-cobrada", DEMO_ACTOR, {
      planCode: ACTION_PLAN.code,
      periodStart: monthStartUTC(now),
      periodEnd: monthEndUTC(now),
    })
    // Hace dos días subió una captura donde no se leía la operación; Ada la rechazó ayer y la
    // clínica subió otra, que se confirmó: «Rechazado: …» en los dos historiales.
    const blurry = await submitSaasReceipt(
      db,
      { storage },
      "seed-saas-cobrada",
      DEMO_ACTOR,
      {
        chargeId: charge.id,
        methodCode: "transferencia-ficticia",
        amountCents: charge.amountCents,
        receipt: {
          bytes: new Uint8Array(DEMO_PNG),
          contentType: "image/png",
          filename: "captura-transferencia.png",
        },
        idempotencyKey: `demo-cobrada-rechazado-${monthKey}`,
      },
      new Date(now.getTime() - 2 * DAY),
    )
    // La fecha de subida va antes de rechazarlo: un comprobante rechazado ya no cambia.
    await db
      .update(saasPayment)
      .set({ createdAt: new Date(now.getTime() - 2 * DAY) })
      .where(and(eq(saasPayment.id, blurry.id), eq(saasPayment.status, "pendiente")))
    await rejectSaasReceipt(
      db,
      "seed-saas-cobrada",
      SEED_STAFF_ADMIN_ID,
      blurry.id,
      "La captura no muestra el número de operación ni la fecha.",
      new Date(now.getTime() - DAY),
    )
    const receipt = await submitSaasReceipt(
      db,
      { storage },
      "seed-saas-cobrada",
      DEMO_ACTOR,
      {
        chargeId: charge.id,
        methodCode: "transferencia-ficticia",
        amountCents: charge.amountCents,
        receipt: {
          bytes: new Uint8Array(DEMO_PNG),
          contentType: "image/png",
          filename: "demo.png",
        },
        idempotencyKey: `demo-cobrada-${monthKey}`,
      },
      now,
    )
    await confirmSaasPayment(db, "seed-saas-cobrada", DEMO_ACTOR, receipt.id, now)
    await settleSaasCommissions(db, DEMO_ACTOR, {
      sellerId: seller.id,
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      currency: ACTION_PLAN.currency,
      notes: "Demo (ficticia)",
    })
  }
  await seedFoundersDemo(db, now)
  return { orgs: ["seed-saas-prueba", "seed-saas-deuda", "seed-saas-cobrada"] }
}

/**
 * Enlace de invitación de la semilla: abre `/register?invitacion=fundadores-demo`
 * en el panel con el correo `fundadora-demo@example.test`. Solo desarrollo.
 */
export const DEMO_FOUNDER_TOKEN = "fundadores-demo"
/** El enlace de la invitación que ya venció: no abre nada; da la etapa «Invitación vencida». */
const DEMO_EXPIRED_TOKEN = "fundadores-demo-vencida"

/** Los seguimientos vuelven un día de Lima, el de la administración. */
const LIMA = "America/Lima"

/** El día de Lima a `offset` días de hoy (`YYYY-MM-DD`). */
function limaDay(now: Date, offset: number): string {
  return addCivilDays(reportDayOf(LIMA, now), offset)
}

/** Hace `daysAgo` días de Lima, a esa hora de Lima; nunca después de ahora. */
function limaAt(now: Date, daysAgo: number, hour: number): Date {
  const [year, month, day] = limaDay(now, -daysAgo).split("-").map(Number) as [number, number, number]
  return new Date(Math.min(dayStart(LIMA, year, month, day).getTime() + hour * HOUR, now.getTime() - 60_000))
}

interface DemoRequest {
  email: string
  firstName: string
  lastName: string
  clinicName: string
  countryCode: string
  city: string
  professionals: string
  currentTool: string
  phone: string
  product?: "medical"
  status: SaasWaitlistStatus
  /** Hace cuántos días llegó. La que entró: cuántos días antes de entrar. */
  ageDays: number
  /** Invitada: su enlace y en cuántas horas vence (negativas: ya venció). */
  invite?: { token: string; expiresInHours: number }
  /** Entró: la clínica de la semilla que abrió (entró el día en que se creó) y el plan con que se la invitó. */
  entered?: { organizationId: string; planCode: string }
  discardReason?: string
}

const DEMO_WAITLIST: readonly DemoRequest[] = [
  { email: "sonrisa-demo@example.test", firstName: "Ana", lastName: "Quispe (ficticia)", clinicName: "Clínica Sonrisa (ficticia)", countryCode: "PE", city: "Arequipa", professionals: "2-3", currentTool: "cuaderno_excel", phone: "+51987654321", status: "por_revisar", ageDays: 0 },
  { email: "andes-demo@example.test", firstName: "Luis", lastName: "Mamani (ficticio)", clinicName: "Dental Andes (ficticia)", countryCode: "PE", city: "Cusco", professionals: "4-9", currentTool: "otro_software", phone: "+51912345678", status: "por_revisar", ageDays: 2 },
  { email: "odontovida-demo@example.test", firstName: "Carla", lastName: "Ruiz (ficticia)", clinicName: "OdontoVida (ficticia)", countryCode: "EC", city: "Quito", professionals: "1", currentTool: "nada", phone: "+593991234567", status: "por_revisar", ageDays: 5 },
  // Vence dentro de 3 días: Inicio la muestra, y el cajón ofrece «Reenviar por correo…».
  { email: "fundadora-demo@example.test", firstName: "Rosa", lastName: "Díaz (ficticia)", clinicName: "Clínica Norte Fundadora (ficticia)", countryCode: "MX", city: "Monterrey", professionals: "2-3", currentTool: "cuaderno_excel", phone: "+528112345678", status: "invitada", ageDays: 12, invite: { token: DEMO_FOUNDER_TOKEN, expiresInHours: 3 * 24 - 1 } },
  { email: "piura-demo@example.test", firstName: "Jorge", lastName: "Paredes (ficticio)", clinicName: "Dental Piura (ficticia)", countryCode: "PE", city: "Piura", professionals: "2-3", currentTool: "cuaderno_excel", phone: "+51934567890", status: "invitada", ageDays: 20, invite: { token: DEMO_EXPIRED_TOKEN, expiresInHours: -4 * 24 } },
  // Una de latidIA: se invita con Fundadores latidIA y gasta sus propios lugares (ADR 0093).
  { email: "latido-demo@example.test", firstName: "Elena", lastName: "Torres (ficticia)", clinicName: "Consultorio Latido (ficticio)", countryCode: "PE", city: "Lima", professionals: "1", currentTool: "cuaderno_excel", phone: "+51923456789", status: "por_revisar", ageDays: 3, product: "medical" },
  { email: "descartada-demo@example.test", firstName: "Pedro", lastName: "Salas (ficticio)", clinicName: "Proveedor Dental (ficticio)", countryCode: "CO", city: "Bogotá", professionals: "10+", currentTool: "otro_software", phone: "+573001234567", status: "descartada", ageDays: 8, discardReason: "Vende insumos dentales, no es una clínica (ficticio)." },
  // Cora, la dueña de Clínica Norte (`dental/seed-demo.ts`), entró con su invitación y sigue en
  // prueba: la etapa «Entró». Esa demo borra y recrea la clínica; aquí se vuelve a unir.
  { email: "cora@odentia.dev", firstName: "Cora", lastName: "Vega", clinicName: "Clínica Norte", countryCode: "PE", city: "Lima", professionals: "2-3", currentTool: "cuaderno_excel", phone: "+51956789012", status: "entro", ageDays: 5, entered: { organizationId: "seed-org-clinica-norte", planCode: FOUNDERS_PLAN.code } },
  // Entró con el plan de lista y ya tiene un pago confirmado: la etapa «Paga».
  { email: "cobrada-demo@example.test", firstName: "Marta", lastName: "Quiroz (ficticia)", clinicName: "Demo Cobrada (ficticia)", countryCode: "PE", city: "Lima", professionals: "4-9", currentTool: "otro_software", phone: "+51945678901", status: "entro", ageDays: 6, entered: { organizationId: "seed-saas-cobrada", planCode: ACTION_PLAN.code } },
]

/**
 * Lo anotado en el seguimiento de las solicitudes por Ada (administración) y
 * Sofía (soporte): hace `daysAgo` días, a `hour` de Lima, y para volver a
 * `followUpIn` días de hoy (nulo: sin fecha). Ids fijos: cada corrida lo
 * vuelve a escribir.
 */
const DEMO_FOLLOW_UPS = [
  { id: "00000000-0000-4000-8000-00000000f501", email: "latido-demo@example.test", authorUserId: SEED_STAFF_SUPPORT_ID, daysAgo: 2, hour: 10, followUpIn: -1, adminOnly: false, body: "No contestó. Volver a llamar por la tarde." },
  { id: "00000000-0000-4000-8000-00000000f502", email: "fundadora-demo@example.test", authorUserId: SEED_STAFF_ADMIN_ID, daysAgo: 1, hour: 11, followUpIn: 0, adminOnly: false, body: "Lo ve con su socia y avisa esta semana." },
  { id: "00000000-0000-4000-8000-00000000f503", email: "andes-demo@example.test", authorUserId: SEED_STAFF_SUPPORT_ID, daysAgo: 1, hour: 16, followUpIn: null, adminOnly: false, body: "Escribió por WhatsApp: usa otro programa y pregunta si podemos traer sus pacientes." },
  { id: "00000000-0000-4000-8000-00000000f504", email: "andes-demo@example.test", authorUserId: SEED_STAFF_ADMIN_ID, daysAgo: 0, hour: 9, followUpIn: 1, adminOnly: false, body: "Le conté que cargamos sus pacientes desde lo que exporta su programa. Lo habla con su equipo y me confirma mañana." },
  // Un precio es de Administración: soporte ve que hay una entrada y su fecha, no el texto.
  { id: "00000000-0000-4000-8000-00000000f505", email: "cobrada-demo@example.test", authorUserId: SEED_STAFF_ADMIN_ID, daysAgo: 1, hour: 15, followUpIn: 0, adminOnly: true, body: "Pide precio especial si suma una segunda sede: responderle antes del próximo cobro." },
  // La «Nota del equipo» de antes, sin autor (la trasladó la migración 0101): no es un contacto,
  // así que OdontoVida sigue en «Prospectos por responder» con su plazo.
  { id: "00000000-0000-4000-8000-00000000f506", email: "odontovida-demo@example.test", authorUserId: null, daysAgo: 4, hour: 12, followUpIn: null, adminOnly: false, fromNote: true, body: "Pedirle a Ada que la llame: pregunta por el plan anual." },
] as const

/** Las fechas de una solicitud, relativas a hoy; las de la que entró, a su clínica. */
function requestDates(row: DemoRequest, now: Date, enteredAt: Date | null) {
  if (enteredAt) {
    const invitedAt = new Date(enteredAt.getTime() - 2 * DAY)
    return {
      createdAt: new Date(enteredAt.getTime() - row.ageDays * DAY),
      updatedAt: enteredAt,
      invitedAt,
      inviteExpiresAt: new Date(invitedAt.getTime() + FOUNDER_INVITATION_DAYS * DAY),
      enteredAt,
    }
  }
  const createdAt = new Date(now.getTime() - row.ageDays * DAY)
  if (!row.invite) return { createdAt, updatedAt: createdAt }
  const inviteExpiresAt = new Date(now.getTime() + row.invite.expiresInHours * HOUR)
  return {
    createdAt,
    updatedAt: createdAt,
    invitedAt: new Date(inviteExpiresAt.getTime() - FOUNDER_INVITATION_DAYS * DAY),
    inviteExpiresAt,
  }
}

/**
 * Fundadores en desarrollo: solicitudes de la lista de espera en cada etapa
 * (por revisar, invitada con el enlace de la semilla y por vencer, invitación
 * vencida, entró, paga y descartada), su seguimiento y un precio negociado que
 * vence en 6 días en «Demo Deuda» (issue 168). Idempotente por correo: lo ya
 * sembrado vuelve a tener fechas de hoy mientras siga como lo dejó la semilla.
 * No envía correos.
 */
export async function seedFoundersDemo(db: Db, now = new Date()): Promise<void> {
  const plans = await db
    .select({ id: saasPlan.id, code: saasPlan.code })
    .from(saasPlan)
    .where(inArray(saasPlan.code, [FOUNDERS_PLAN.code, ACTION_PLAN.code]))
  const planOf = (code: string) => plans.find((plan) => plan.code === code)?.id
  const foundersPlanId = planOf(FOUNDERS_PLAN.code)
  if (!foundersPlanId) return
  const orgs = await db
    .select({ id: organization.id, createdAt: organization.createdAt })
    .from(organization)
    .where(inArray(organization.id, DEMO_WAITLIST.flatMap((row) => (row.entered ? [row.entered.organizationId] : []))))
  for (const row of DEMO_WAITLIST) {
    const { ageDays: _ageDays, invite, entered, discardReason, status, ...data } = row
    const org = entered ? orgs.find((item) => item.id === entered.organizationId) : undefined
    const planId = entered ? planOf(entered.planCode) : invite ? foundersPlanId : undefined
    // Sin su clínica (la semilla corrió sin la demo de la clínica) no entró a ninguna.
    if (entered && (!org || !planId)) continue
    const tokenHash = invite ? invitationTokenHash(invite.token) : undefined
    const state = {
      ...requestDates(row, now, org?.createdAt ?? null),
      ...(planId ? { planId } : {}),
      ...(tokenHash ? { tokenHash } : {}),
      ...(org ? { organizationId: org.id } : {}),
    }
    const [found] = await db
      .select({ id: saasWaitlistRequest.id })
      .from(saasWaitlistRequest)
      .where(eq(saasWaitlistRequest.email, row.email))
      .limit(1)
    if (!found) {
      await db.insert(saasWaitlistRequest).values({ ...data, status, ...state, ...(discardReason ? { discardReason } : {}) })
      continue
    }
    // Ya sembrada: solo si sigue como la dejó la semilla (la invitación, con su enlace).
    await db
      .update(saasWaitlistRequest)
      .set(state)
      .where(
        and(
          eq(saasWaitlistRequest.id, found.id),
          eq(saasWaitlistRequest.status, status),
          tokenHash ? eq(saasWaitlistRequest.tokenHash, tokenHash) : undefined,
        ),
      )
  }
  await linkDemoRequestsToClients(db, now)

  // El seguimiento solo se agrega (`saas_follow_up_append_only`): lo de la semilla se borra
  // por su id y se vuelve a escribir con las fechas de hoy; lo que anotó una persona queda.
  const staff = await db
    .select({ id: user.id })
    .from(user)
    .where(inArray(user.id, [SEED_STAFF_ADMIN_ID, SEED_STAFF_SUPPORT_ID]))
  if (staff.length === 2) {
    const requests = await db
      .select({ id: saasWaitlistRequest.id, email: saasWaitlistRequest.email, clientId: saasWaitlistRequest.clientId })
      .from(saasWaitlistRequest)
      .where(inArray(saasWaitlistRequest.email, DEMO_FOLLOW_UPS.map((entry) => entry.email)))
    await db.delete(saasFollowUp).where(inArray(saasFollowUp.id, DEMO_FOLLOW_UPS.map((entry) => entry.id)))
    const entries = DEMO_FOLLOW_UPS.flatMap((entry) => {
      const request = requests.find((item) => item.email === entry.email)
      if (!request) return []
      const createdAt = limaAt(now, entry.daysAgo, entry.hour)
      return [
        {
          id: entry.id,
          requestId: request.id,
          // También es del cliente de la solicitud (ADR 0183): su ficha lo ve en el historial.
          clientId: request.clientId,
          happenedAt: createdAt,
          authorUserId: entry.authorUserId,
          body: entry.body,
          followUpOn: entry.followUpIn === null ? null : limaDay(now, entry.followUpIn),
          adminOnly: entry.adminOnly,
          fromNote: "fromNote" in entry ? entry.fromNote : false,
          createdAt,
        },
      ]
    })
    if (entries.length > 0) await db.insert(saasFollowUp).values(entries)
  }

  // Precio negociado que vence pronto: la etiqueta roja de Clínicas y el aviso de Inicio.
  await db
    .update(saasSubscription)
    .set({ discountBps: 1000, discountEndsAt: new Date(now.getTime() + 6 * 86_400_000), updatedAt: now })
    .where(and(eq(saasSubscription.organizationId, "seed-saas-deuda"), eq(saasSubscription.discountBps, 0)))
}

/**
 * Cada solicitud de la semilla con su cliente del ARM (ADR 0183), con la misma
 * operación que la solicitud de la web (`clientForWaitlistRequest`): la que
 * entró queda ligada a su cuenta y la descartada, perdida con su motivo. La de
 * una clínica que es demo (Clínica Norte) no da cliente: una demo nunca es
 * cliente. Idempotente: solo toca las que aún no tienen cliente.
 */
async function linkDemoRequestsToClients(db: Db, now: Date): Promise<void> {
  const requests = await db
    .select()
    .from(saasWaitlistRequest)
    .where(
      and(
        inArray(saasWaitlistRequest.email, DEMO_WAITLIST.map((row) => row.email)),
        isNull(saasWaitlistRequest.clientId),
      ),
    )
  const [admin] = await db.select({ id: user.id }).from(user).where(eq(user.id, SEED_STAFF_ADMIN_ID)).limit(1)
  const ada: AdminActor = { userId: SEED_STAFF_ADMIN_ID, role: "admin" }
  for (const request of requests) {
    if (request.organizationId) {
      const [demo] = [
        ...(await db.execute<{ demo: boolean }>(sql`select (
          exists (select 1 from ${saasDemo} d where d.organization_id = ${request.organizationId})
          or exists (select 1 from ${saasSubscription} s where s.organization_id = ${request.organizationId} and s.is_demo)
        ) as demo`)),
      ]
      if (demo?.demo) continue
    }
    const clientId = await clientForWaitlistRequest(
      db,
      {
        email: request.email,
        firstName: request.firstName,
        lastName: request.lastName,
        phone: request.phone,
        clinicName: request.clinicName,
        countryCode: request.countryCode,
        city: request.city,
        professionals: request.professionals,
        currentTool: request.currentTool,
        product: isClinicalProduct(request.product) ? request.product : "dental",
      },
      request.createdAt,
    )
    await db.update(saasWaitlistRequest).set({ clientId }).where(eq(saasWaitlistRequest.id, request.id))
    if (request.organizationId) {
      await linkClientToOrganization(db, null, {
        clientId,
        organizationId: request.organizationId,
        origin: "web",
        now: request.enteredAt ?? now,
      })
    } else if (request.status === "descartada" && admin) {
      await decide(
        db,
        ada,
        clientId,
        { decision: "perdido", reason: "no_es_una_clinica", reasonDetail: request.discardReason },
        request.decidedAt ?? new Date(request.createdAt.getTime() + DAY),
      )
    }
  }
}

/**
 * Clínicas de Ana con los avisos de cobro de la franja (ADR 0065), para ver el
 * selector «Elige tu clínica», el menú de la clínica y la franja con datos:
 * un cargo que vence pasado mañana, una clínica en solo lectura y otra en su
 * presupuesto del mes. Luis entra como odontólogo a la de solo lectura y a la
 * del presupuesto, para ver el texto del resto del equipo. Sin correos. Idempotente: si
 * la clínica ya existe, vuelve a poner las fechas relativas a hoy y, como
 * `seed-dev` borra y recrea a Ana y a Luis, su membresía y la aceptación del
 * contrato (que se van con ellos).
 */
export async function seedClinicNoticesDemo(db: Db, input: { ownerUserId: string; professionalUserId: string; acceptedVersion: string }): Promise<void> {
  const now = new Date()
  const day = 86_400_000
  const clinics = [
    { id: "seed-aviso-por-vencer", name: "Ortodoncia Lima (demo)", slug: "orto-lima-demo", branches: ["Sede Centro", "Sede Jesús María"], professional: false },
    { id: "seed-aviso-solo-lectura", name: "Bocas Felices (demo)", slug: "bocas-felices-demo", branches: ["Sede Única"], professional: true },
    { id: "seed-aviso-tope", name: "Sonrisa Miraflores (demo)", slug: "sonrisa-miraflores-demo", branches: ["Sede Miraflores"], professional: true },
  ] as const
  for (const clinic of clinics) {
    const [exists] = await db.select({ id: organization.id }).from(organization).where(eq(organization.id, clinic.id)).limit(1)
    if (!exists) {
      await ensureFinishedSignupOrg(db, clinic)
      await startSaasTrial(db, clinic.id, { planCode: "odentia-ficticio", billingStart: "now" }, now)
    }
    // También en una clínica que ya existía: Ana y Luis se recrean en cada corrida.
    await db
      .insert(member)
      .values([
        { id: `${clinic.id}-ana`, organizationId: clinic.id, userId: input.ownerUserId, role: "owner", createdAt: now },
        ...(clinic.professional ? [{ id: `${clinic.id}-luis`, organizationId: clinic.id, userId: input.professionalUserId, role: "clinician", createdAt: now }] : []),
      ])
      .onConflictDoNothing()
    await db
      .insert(processingAgreementAcceptance)
      .values({ organizationId: clinic.id, version: input.acceptedVersion, acceptedBy: input.ownerUserId })
      .onConflictDoNothing()
  }

  // Un cargo que vence pasado mañana: franja ámbar para Ana, «Pagar» en el selector.
  const [porVencer] = await db.select({ id: saasCharge.id }).from(saasCharge).where(eq(saasCharge.organizationId, "seed-aviso-por-vencer")).limit(1)
  const chargeA = porVencer ?? (await createSaasCharge(db, "seed-aviso-por-vencer", DEMO_ACTOR, { planCode: "odentia-ficticio", periodStart: monthStartUTC(now), periodEnd: monthEndUTC(now) }))
  await db.update(saasCharge).set({ dueAt: new Date(now.getTime() + 2 * day - 3_600_000) }).where(eq(saasCharge.id, chargeA.id))

  // Solo lectura por falta de pago: venció hace 10 días y pasó la gracia.
  const [vencido] = await db.select({ id: saasCharge.id }).from(saasCharge).where(eq(saasCharge.organizationId, "seed-aviso-solo-lectura")).limit(1)
  const chargeB = vencido ?? (await createSaasCharge(db, "seed-aviso-solo-lectura", DEMO_ACTOR, { planCode: "odentia-ficticio", periodStart: monthStartUTC(now), periodEnd: monthEndUTC(now) }))
  await db.update(saasCharge).set({ dueAt: new Date(now.getTime() - 10 * day) }).where(eq(saasCharge.id, chargeB.id))
  await db
    .update(saasSubscription)
    .set({ status: "restringida", restrictReason: "gracia_vencida", graceEndsAt: new Date(now.getTime() - 3 * day), updatedAt: now })
    .where(eq(saasSubscription.organizationId, "seed-aviso-solo-lectura"))

  // En el presupuesto: 120 conversaciones de USD 0,50 este mes, por encima del crédito, con un presupuesto de USD 5.
  await db.update(saasSubscription).set({ spendCapCents: 500, updatedAt: now }).where(eq(saasSubscription.organizationId, "seed-aviso-tope"))
  await db.delete(saasAction).where(and(eq(saasAction.organizationId, "seed-aviso-tope"), inArray(saasAction.kind, ["conversacion"])))
  await db.insert(saasAction).values(
    Array.from({ length: 120 }, (_, index) => ({
      organizationId: "seed-aviso-tope",
      kind: "conversacion",
      tier: "gestiona",
      occurredAt: new Date(now.getTime() - (index + 1) * 1_800_000),
      detail: "Atendió una conversación por WhatsApp (demo)",
      channel: "whatsapp",
      currency: "USD",
      basePriceMicros: 500_000,
      priceMicros: 500_000,
      dedupeKey: `semilla:tope:${index}`,
    })),
  )
}
