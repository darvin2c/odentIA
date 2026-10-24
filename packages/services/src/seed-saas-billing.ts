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
import type { Db } from "@odentia/db"
import { member, organization, user } from "@odentia/db/schema/auth"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { processingAgreementAcceptance } from "@odentia/db/schema/workspace"
import {
  saasAction,
  saasCharge,
  saasCommercialTerms,
  saasPayment,
  saasPaymentMethod,
  saasPlan,
  saasSubscription,
  saasWaitlistRequest,
} from "@odentia/db/schema/saas-billing"
import { and, eq, inArray, isNull } from "drizzle-orm"
import {
  confirmSaasPayment,
  createSaasCharge,
  monthEndUTC,
  monthKeyUTC,
  monthStartUTC,
  settleSaasCommissions,
  startSaasTrial,
  submitSaasReceipt,
  upsertSaasSeller,
} from "./saas-billing.js"
import { SAAS_TERMS_INITIAL } from "./saas-commercial-terms.js"
import { invitationTokenHash } from "./saas-founders.js"
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

/** Los precios por tipo de la ADR 0085, por un factor (Fundadores: la mitad). */
function tierPlan(factor: number) {
  const price = (usd: number) => Math.round(usd * factor * 1_000_000)
  return {
    conversationInformMicros: price(0.1),
    conversationMicros: price(0.5),
    conversationAgendaMicros: price(1),
    consultationSimpleMicros: price(0.1),
    consultationStandardMicros: price(0.2),
    consultationMicros: price(0.5),
    recoveryMicros: price(2),
    argosIncludedQuestions: 300,
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

/**
 * El plan de las ADR 0031 y 0085 para probar el cobro por acción: USD 29 que
 * vuelven en crédito, el precio de cada tipo (Sofi 0,10 / 0,50 / 1,00, Clío
 * 0,10 / 0,20 / 0,50, cita recuperada 2), 300 preguntas a Argos y paquetes de
 * 100 por 3, 20 GB y 0,20 por GB extra, y prueba de USD 100 y 30 días. Es el
 * plan por defecto de la semilla; en producción lo configura administración.
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
  trialCreditCents: 10000,
  trialDays: 30,
  trialMaxCreditCents: 13000,
  trialMaxDays: 60,
  isDefault: true,
  showOnWeb: true,
} as const

/**
 * El plan por invitación de Fundadores (issue 165, ADR 0085): sin cuota, USD
 * 100 de regalo hasta 90 días, todo con 50 % menos, 20 lugares y 12 meses
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
  trialCreditCents: 10000,
  trialDays: 90,
  trialMaxCreditCents: 10000,
  trialMaxDays: 90,
  seatLimit: 20,
  guaranteeMonths: 12,
  showOnWeb: true,
} as const

/** Catálogo ficticio (no pisa lo editado: solo inserta lo ausente). */
export async function seedSaasBilling(db: Db): Promise<{ plans: number; methods: number }> {
  await db.insert(saasPlan).values(ACTION_PLAN).onConflictDoNothing({ target: saasPlan.code })
  await db.insert(saasPlan).values(FOUNDERS_PLAN).onConflictDoNothing({ target: saasPlan.code })
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
  return { plans: 2, methods: FICTIONAL_METHODS.length }
}

const DEMO_ACTOR = "seed-saas-demo"
const DEMO_SELLER_USER = "seed-saas-demo-seller"

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

  await ensureDemoOrg(db, "seed-saas-deuda", "Demo Deuda (ficticia)", "saas-demo-deuda")
  await startSaasTrial(
    db,
    "seed-saas-deuda",
    { planCode: ACTION_PLAN.code, sellerId: seller.id, billingStart: "now" },
    now,
  )
  const dueCharge = await db
    .select({ id: saasPayment.id })
    .from(saasPayment)
    .where(
      and(eq(saasPayment.organizationId, "seed-saas-deuda"), eq(saasPayment.status, "pendiente")),
    )
    .limit(1)
  if (dueCharge.length === 0) {
    const charge = await createSaasCharge(db, "seed-saas-deuda", DEMO_ACTOR, {
      planCode: ACTION_PLAN.code,
      periodStart: monthStartUTC(now),
      periodEnd: monthEndUTC(now),
    })
    await submitSaasReceipt(
      db,
      { storage },
      "seed-saas-deuda",
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
        idempotencyKey: `demo-deuda-${monthKey}`,
      },
      now,
    )
  }

  await ensureDemoOrg(db, "seed-saas-cobrada", "Demo Cobrada (ficticia)", "saas-demo-cobrada")
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

const DEMO_WAITLIST = [
  { email: "sonrisa-demo@example.test", firstName: "Ana", lastName: "Quispe (ficticia)", clinicName: "Clínica Sonrisa (ficticia)", countryCode: "PE", city: "Arequipa", professionals: "2-3", currentTool: "cuaderno_excel", phone: "+51987654321", status: "por_revisar", ageDays: 0 },
  { email: "andes-demo@example.test", firstName: "Luis", lastName: "Mamani (ficticio)", clinicName: "Dental Andes (ficticia)", countryCode: "PE", city: "Cusco", professionals: "4-9", currentTool: "otro_software", phone: "+51912345678", status: "por_revisar", ageDays: 1 },
  { email: "odontovida-demo@example.test", firstName: "Carla", lastName: "Ruiz (ficticia)", clinicName: "OdontoVida (ficticia)", countryCode: "EC", city: "Quito", professionals: "1", currentTool: "nada", phone: "+593991234567", status: "por_revisar", ageDays: 5 },
  { email: "fundadora-demo@example.test", firstName: "Rosa", lastName: "Díaz (ficticia)", clinicName: "Clínica Norte Fundadora (ficticia)", countryCode: "MX", city: "Monterrey", professionals: "2-3", currentTool: "cuaderno_excel", phone: "+528112345678", status: "invitada", ageDays: 3 },
  { email: "descartada-demo@example.test", firstName: "Pedro", lastName: "Salas (ficticio)", clinicName: "Proveedor Dental (ficticio)", countryCode: "CO", city: "Bogotá", professionals: "10+", currentTool: "otro_software", phone: "+573001234567", status: "descartada", ageDays: 8 },
] as const

/**
 * Fundadores en desarrollo: solicitudes de la lista de espera en cada estado
 * (por revisar, invitada con el enlace de la semilla, descartada) y un precio
 * negociado que vence en 6 días en «Demo Deuda» (issue 168). Idempotente por
 * correo; no envía correos.
 */
export async function seedFoundersDemo(db: Db, now = new Date()): Promise<void> {
  const [plan] = await db.select({ id: saasPlan.id }).from(saasPlan).where(eq(saasPlan.code, FOUNDERS_PLAN.code)).limit(1)
  if (!plan) return
  for (const row of DEMO_WAITLIST) {
    const [found] = await db.select({ id: saasWaitlistRequest.id }).from(saasWaitlistRequest).where(eq(saasWaitlistRequest.email, row.email)).limit(1)
    if (found) continue
    const createdAt = new Date(now.getTime() - row.ageDays * 86_400_000)
    const { ageDays: _ageDays, status, ...data } = row
    await db.insert(saasWaitlistRequest).values({
      ...data,
      status,
      createdAt,
      updatedAt: createdAt,
      ...(status === "invitada"
        ? {
            planId: plan.id,
            tokenHash: invitationTokenHash(DEMO_FOUNDER_TOKEN),
            invitedAt: createdAt,
            inviteExpiresAt: new Date(createdAt.getTime() + 14 * 86_400_000),
          }
        : {}),
      ...(status === "descartada" ? { discardReason: "Vende insumos dentales, no es una clínica (ficticio)." } : {}),
    })
  }
  // Precio negociado que vence pronto: la etiqueta roja de Clínicas y el aviso de Inicio.
  await db
    .update(saasSubscription)
    .set({ discountBps: 1000, discountEndsAt: new Date(now.getTime() + 6 * 86_400_000), updatedAt: now })
    .where(and(eq(saasSubscription.organizationId, "seed-saas-deuda"), eq(saasSubscription.discountBps, 0)))
}

/**
 * Clínicas de Ana con los avisos de cobro de la franja (ADR 0065), para ver el
 * selector «Elige tu clínica», el menú de la clínica y la franja con datos:
 * un cargo que vence pasado mañana, una clínica en solo lectura y otra en su
 * tope de gasto. Luis entra como odontólogo a la de solo lectura y a la del
 * tope, para ver el texto del resto del equipo. Sin correos. Idempotente: si
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
      await ensureDemoOrg(db, clinic.id, clinic.name, clinic.slug)
      await db.insert(orgProfile).values({
        organizationId: clinic.id,
        legalName: `${clinic.name} S.A.C.`,
        tradeName: clinic.name,
        countryCode: "PE",
        currency: "PEN",
        locale: "es-PE",
        timezone: "America/Lima",
        diagnosisSystem: "ICD-10",
      })
      await db.insert(branch).values(clinic.branches.map((name) => ({ organizationId: clinic.id, name })))
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

  // En el tope: 120 conversaciones de USD 0,50 este mes, por encima del crédito, con un tope de USD 5.
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
