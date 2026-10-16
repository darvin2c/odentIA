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
import { organization, user } from "@odentia/db/schema/auth"
import { saasPayment, saasPaymentMethod, saasPlan } from "@odentia/db/schema/saas-billing"
import { and, eq } from "drizzle-orm"
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
import type { Storage } from "./storage.js"

const FICTIONAL_PLANS = [
  {
    code: "ejemplo-ficticio-base",
    name: "Plan Base (ficticio)",
    description: "Ejemplo ficticio para prueba manual; no contratar.",
    currency: "PEN",
    priceCents: 9900,
    billingPeriod: "mensual",
    maxBranches: 1,
    maxSeats: 5,
    sortOrder: 1,
  },
  {
    code: "ejemplo-ficticio-plus",
    name: "Plan Plus (ficticio)",
    description: "Ejemplo ficticio para prueba manual; no contratar.",
    currency: "PEN",
    priceCents: 19900,
    billingPeriod: "mensual",
    maxBranches: 3,
    maxSeats: 15,
    sortOrder: 2,
  },
  {
    code: "ejemplo-ficticio-base-usd",
    name: "Plan Base USD (ficticio)",
    description: "Ejemplo ficticio para prueba manual; no contratar.",
    currency: "USD",
    priceCents: 2900,
    billingPeriod: "mensual",
    maxBranches: 1,
    maxSeats: 5,
    sortOrder: 3,
  },
] as const

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

/**
 * El plan de la ADR 0030 para probar el cobro por acción: USD 29 que vuelven
 * en crédito, precio base por acción y prueba de USD 50 y 30 días. Es el plan
 * por defecto de la semilla; en producción lo configura administración.
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
  conversationMicros: 500_000,
  consultationMicros: 400_000,
  recoveryMicros: 4_000_000,
  maxDiscountBps: 6000,
  sellerDiscountBps: 1000,
  trialCreditCents: 5000,
  trialDays: 30,
  trialMaxCreditCents: 13000,
  trialMaxDays: 60,
  isDefault: true,
} as const

/** Catálogo ficticio (no pisa lo editado: solo inserta lo ausente). */
export async function seedSaasBilling(db: Db): Promise<{ plans: number; methods: number }> {
  await db.insert(saasPlan).values(ACTION_PLAN).onConflictDoNothing({ target: saasPlan.code })
  for (const plan of FICTIONAL_PLANS) {
    await db
      .insert(saasPlan)
      .values({
        code: plan.code,
        name: plan.name,
        description: plan.description,
        currency: plan.currency,
        priceCents: plan.priceCents,
        billingPeriod: plan.billingPeriod,
        maxBranches: plan.maxBranches,
        maxSeats: plan.maxSeats,
        sortOrder: plan.sortOrder,
      })
      .onConflictDoNothing({ target: saasPlan.code })
  }
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
  return { plans: FICTIONAL_PLANS.length + 1, methods: FICTIONAL_METHODS.length }
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
  await startSaasTrial(db, "seed-saas-prueba", { planCode: "ejemplo-ficticio-base" }, now)

  await ensureDemoOrg(db, "seed-saas-deuda", "Demo Deuda (ficticia)", "saas-demo-deuda")
  await startSaasTrial(
    db,
    "seed-saas-deuda",
    { planCode: "ejemplo-ficticio-plus", sellerId: seller.id, billingStart: "now" },
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
      planCode: "ejemplo-ficticio-plus",
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
    { planCode: "ejemplo-ficticio-base", sellerId: seller.id, billingStart: "now" },
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
      planCode: "ejemplo-ficticio-base",
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
      currency: "PEN",
      notes: "Demo (ficticia)",
    })
  }
  return { orgs: ["seed-saas-prueba", "seed-saas-deuda", "seed-saas-cobrada"] }
}
