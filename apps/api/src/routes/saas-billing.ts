/**
 * Facturación SaaS: el backoffice exige rol interno admin y segundo factor.
 * Las rutas de cuenta comprueban membresía y rol de clínica; plan y pagos
 * permanecen disponibles aunque la operación clínica esté restringida.
 */
import type { Auth } from "@odentia/auth"
import { seesBilling } from "@odentia/auth/permissions"
import { type Db, withOrgContext } from "@odentia/db"
import { invitation, member } from "@odentia/db/schema/auth"
import type { Mailer } from "@odentia/mail"
import {
  type AdminActor,
  activateSaasSubscription,
  archiveSaasPlan,
  assertSaasAllowed,
  assertSaasSeatAvailable,
  chooseSaasPlan,
  claimSaasNoticeMail,
  completeSaasNoticeMail,
  confirmSaasPayment,
  createSaasCharge,
  createSaasPlan,
  decideSaasAccess,
  checkActionPricing,
  currentSaasPeriod,
  previousSaasPeriod,
  requestActionReview,
  SAAS_REVIEW_REASONS,
  decideSaasNegotiation,
  getSaasAlerts,
  getSaasLowMargin,
  getSaasTrialWatch,
  getWhatsappEstimate,
  isChargingPeriod,
  listSaasNegotiations,
  listWhatsappRates,
  planMarginScenario,
  saasTaxOf,
  setSaasSpendCap,
  upsertWhatsappRate,
  getOrganizationBillingSummary,
  getSaasConsumption,
  listPendingRecoveries,
  listSaasChargeLines,
  listPeriodActions,
  getSaasReceiptUrl,
  getSaasSubscription,
  getSaasUsage30d,
  listPendingSaasCommissions,
  listPendingSaasPayments,
  listSaasCharges,
  listSaasOverview,
  listSaasPaymentMethods,
  listSaasPayments,
  listSaasPlans,
  listSaasSellers,
  listSaasSettlements,
  listSaasUnassigned,
  pauseSaasSubscription,
  refundSaasPayment,
  registerManualSaasPayment,
  resumeSaasSubscription,
  reverseSaasPayment,
  type SaasOperation,
  ServiceError,
  type Storage,
  setSaasDemo,
  settleSaasCommissions,
  startSaasTrial,
  submitSaasReceipt,
  updateSaasPlan,
  upsertSaasPaymentMethod,
  upsertSaasSeller,
  voidSaasSettlement,
  writeAdminAudit,
} from "@odentia/services"
import { and, eq } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import { adminContextOf } from "../lib/admin-context.js"
import { errorBody } from "../lib/error.js"
import { runService, validationError } from "./helpers.js"

export interface SaasBillingAdminDeps {
  ownerDb: Db
  storage: Storage
  mailer: Mailer
}

export interface SaasBillingAccountDeps {
  auth: Auth
  db: Db
  storage: Storage
}

/**
 * Staff del guard (`requireAdminContext` + MFA viva). Todo el namespace
 * `/api/admin/billing` es admin-only: support no ve cobros ni comisiones
 * Las vistas de soporte reciben otro DTO, sin información financiera.
 */
function requireAdmin(c: Context): AdminActor | null {
  let actor: AdminActor
  try {
    actor = adminContextOf(c)
  } catch {
    return null
  }
  return actor.role === "admin" ? actor : null
}
function forbid(c: Context, message = "No tienes acceso a facturación") {
  return c.json(errorBody(c, "FORBIDDEN", message), 403)
}

const cents = z.number().int().min(0).max(2147483647)
const currency = z.string().regex(/^[A-Z]{3}$/)
const isoDateTime = z.iso.datetime({ offset: true })
const planInput = z
  .object({
    code: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).nullish(),
    currency,
    priceCents: cents,
    billingPeriod: z.string().max(40).nullish(),
    maxBranches: z.number().int().positive().max(100000).nullish(),
    maxSeats: z.number().int().positive().max(1000000).nullish(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    creditCents: cents.optional(),
    conversationMicros: z.number().int().min(0).max(1_000_000_000).nullish(),
    consultationMicros: z.number().int().min(0).max(1_000_000_000).nullish(),
    recoveryMicros: z.number().int().min(0).max(1_000_000_000).nullish(),
    maxDiscountBps: z.number().int().min(0).max(9000).optional(),
    sellerDiscountBps: z.number().int().min(0).max(9000).optional(),
    trialCreditCents: cents.optional(),
    trialDays: z.number().int().min(1).max(365).optional(),
    trialMaxCreditCents: cents.optional(),
    trialMaxDays: z.number().int().min(1).max(365).optional(),
    isDefault: z.boolean().optional(),
  })
  .strict()

export function createSaasBillingRoute(deps: SaasBillingAdminDeps) {
  const app = new Hono()

  async function runStaffWrite<T>(
    c: Context,
    status: 200 | 201,
    actor: AdminActor,
    audit: {
      action: string
      organizationId?: string
      entityId?: string | null
      metadata?: Record<string, unknown>
    },
    fn: (tx: Db) => Promise<T>,
  ) {
    return runService(c, status, () =>
      deps.ownerDb.transaction(async (tx) => {
        const result = await fn(tx)
        await writeAdminAudit(tx, actor, {
          action: audit.action,
          organizationId: audit.organizationId,
          entityId: audit.entityId,
          metadata: audit.metadata,
        })
        return result
      }),
    )
  }

  app.get("/payments", async (c) => {
    if (!requireAdmin(c)) return forbid(c)
    const parsed = z.object({ organizationId: z.string().min(1) }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => listSaasPayments(deps.ownerDb, parsed.data.organizationId))
  })

  // --- Tablero ------------------------------------------------------------------
  app.get("/overview", async (c) => {
    if (!requireAdmin(c)) return forbid(c)
    const parsed = z
      .object({
        status: z
          .enum(["prueba", "activa", "gracia", "restringida", "pausada", "cancelada"])
          .optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const query = parsed.data
    return runService(c, 200, () =>
      listSaasOverview(deps.ownerDb, { status: query.status, limit: query.limit }),
    )
  })

  app.get("/subscriptions/:orgId", async (c) => {
    if (!requireAdmin(c)) return forbid(c)
    const orgId = c.req.param("orgId")
    return runService(c, 200, () => getOrganizationBillingSummary(deps.ownerDb, orgId))
  })

  app.post("/subscriptions/:orgId/demo", async (c) => {
    const actor = requireAdmin(c)
    if (!actor) return forbid(c, "Solo administración cambia el modo demo")
    const parsed = z
      .object({ isDemo: z.boolean() })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const orgId = c.req.param("orgId")
    return runStaffWrite(
      c,
      200,
      actor,
      { action: parsed.data.isDemo ? "saas.demo_on" : "saas.demo_off", organizationId: orgId },
      (tx) => setSaasDemo(tx, orgId, actor.userId, parsed.data.isDemo),
    )
  })

  app.post("/subscriptions/:orgId/pause", async (c) => {
    const actor = requireAdmin(c)
    if (!actor) return forbid(c, "Solo administración pausa suscripciones")
    const parsed = z
      .object({ pauseReason: z.string().trim().min(1).max(2000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const orgId = c.req.param("orgId")
    return runStaffWrite(
      c,
      200,
      actor,
      {
        action: "saas.paused",
        organizationId: orgId,
        metadata: { pauseReason: parsed.data.pauseReason },
      },
      (tx) => pauseSaasSubscription(tx, orgId, actor.userId, parsed.data.pauseReason),
    )
  })

  app.post("/subscriptions/:orgId/resume", async (c) => {
    const actor = requireAdmin(c)
    if (!actor) return forbid(c, "Solo administración reanuda suscripciones")
    const orgId = c.req.param("orgId")
    return runStaffWrite(c, 200, actor, { action: "saas.resumed", organizationId: orgId }, (tx) =>
      resumeSaasSubscription(tx, orgId, actor.userId),
    )
  })
  // Admin asigna plan a una clínica legada (sin fila): la pone en `activa`
  // 30 días, sin deuda retroactiva. Si ya hay fila, solo cambia el plan.
  app.post("/subscriptions/:orgId/activate", async (c) => {
    const actor = requireAdmin(c)
    if (!actor) return forbid(c, "Solo administración asigna planes")
    const parsed = z
      .object({ planCode: z.string().trim().min(1).max(80) })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const orgId = c.req.param("orgId")
    return runStaffWrite(
      c,
      200,
      actor,
      {
        action: "saas.activated",
        organizationId: orgId,
        metadata: { planCode: parsed.data.planCode },
      },
      (tx) => activateSaasSubscription(tx, orgId, actor.userId, parsed.data.planCode),
    )
  })

  // Clínicas legadas sin fila (exentas hasta que admin asigne plan).
  app.get("/unassigned", async (c) => {
    if (!requireAdmin(c)) return forbid(c)
    const parsed = z
      .object({ limit: z.coerce.number().int().min(1).max(200).optional() })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => listSaasUnassigned(deps.ownerDb, parsed.data.limit))
  })

  // --- Planes y métodos ------------------------------------------------------------
  app.get("/plans", async (c) => {
    if (!requireAdmin(c)) return forbid(c)
    const parsed = z
      .object({
        currency: currency.optional(),
        includeInactive: z.enum(["0", "1"]).optional(),
      })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const query = parsed.data
    return runService(c, 200, () =>
      listSaasPlans(deps.ownerDb, {
        currency: query.currency,
        includeInactive: query.includeInactive === "1",
      }),
    )
  })

  app.post("/plans", async (c) => {
    const actor = requireAdmin(c)
    if (!actor) return forbid(c, "Solo administración configura planes")
    const parsed = planInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runStaffWrite(
      c,
      201,
      actor,
      { action: "saas.plan_created", metadata: { code: parsed.data.code } },
      async (tx) => {
        const row = await createSaasPlan(tx, actor.userId, parsed.data)
        return row
      },
    )
  })

  app.patch("/plans/:id", async (c) => {
    const actor = requireAdmin(c)
    if (!actor) return forbid(c, "Solo administración configura planes")
    const parsed = planInput
      .partial()
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runStaffWrite(
      c,
      200,
      actor,
      { action: "saas.plan_updated", entityId: c.req.param("id") },
      async (tx) => {
        const row = await updateSaasPlan(tx, actor.userId, c.req.param("id"), parsed.data)
        return row
      },
    )
  })

  // O1: la comprobación que el servidor exige al guardar, para verla antes.
  app.post("/plans/check", async (c) => {
    if (!requireAdmin(c)) return forbid(c)
    const parsed = z
      .object({
        currency,
        priceCents: cents,
        creditCents: cents,
        conversationMicros: z.number().int().min(0).nullable(),
        consultationMicros: z.number().int().min(0).nullable(),
        recoveryMicros: z.number().int().min(0).nullable(),
        maxDiscountBps: z.number().int().min(0).max(9000),
      })
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return c.json({
      data: { checks: checkActionPricing(parsed.data), margin: planMarginScenario(parsed.data) },
    })
  })

  // Tarifas de Meta para la estimación de WhatsApp que ve la clínica.
  app.get("/whatsapp-rates", async (c) => {
    if (!requireAdmin(c)) return forbid(c)
    return runService(c, 200, () => listWhatsappRates(deps.ownerDb))
  })

  app.put("/whatsapp-rates", async (c) => {
    const actor = requireAdmin(c)
    if (!actor) return forbid(c, "Solo administración carga las tarifas de WhatsApp")
    const parsed = z
      .object({
        countryCode: z.string().regex(/^[A-Za-z]{2}$/),
        category: z.enum(["marketing", "utility", "authentication"]),
        currency,
        priceMicros: z.number().int().min(0).max(1_000_000_000),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runStaffWrite(
      c,
      200,
      actor,
      { action: "saas.whatsapp_rate_set", metadata: { countryCode: parsed.data.countryCode, category: parsed.data.category } },
      async (tx) => {
        await upsertWhatsappRate(tx, actor, parsed.data)
        return { ok: true }
      },
    )
  })

  // O3: pruebas por vencer o sin saldo, y clínicas con margen bajo.
  app.get("/trial-watch", async (c) => {
    if (!requireAdmin(c)) return forbid(c)
    return runService(c, 200, () => getSaasTrialWatch(deps.ownerDb))
  })

  app.get("/low-margin", async (c) => {
    if (!requireAdmin(c)) return forbid(c)
    return runService(c, 200, () => getSaasLowMargin(deps.ownerDb))
  })

  app.get("/negotiations", async (c) => {
    if (!requireAdmin(c)) return forbid(c)
    return runService(c, 200, () => listSaasNegotiations(deps.ownerDb, { status: "pendiente" }))
  })

  app.post("/negotiations/:id/decide", async (c) => {
    const actor = requireAdmin(c)
    if (!actor) return forbid(c, "Solo administración aprueba descuentos y pruebas")
    const parsed = z
      .object({ approve: z.boolean() })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runStaffWrite(
      c,
      200,
      actor,
      { action: parsed.data.approve ? "saas.negotiation_approved" : "saas.negotiation_rejected", entityId: c.req.param("id") },
      async (tx) => {
        await decideSaasNegotiation(tx, actor, c.req.param("id"), parsed.data.approve)
        return { ok: true }
      },
    )
  })

  app.post("/plans/:id/archive", async (c) => {
    const actor = requireAdmin(c)
    if (!actor) return forbid(c, "Solo administración archiva planes")
    return runStaffWrite(
      c,
      200,
      actor,
      { action: "saas.plan_archived", entityId: c.req.param("id") },
      async (tx) => {
        const row = await archiveSaasPlan(tx, actor.userId, c.req.param("id"))
        return row
      },
    )
  })

  app.get("/methods", async (c) => {
    if (!requireAdmin(c)) return forbid(c)
    const parsed = z
      .object({ includeInactive: z.enum(["0", "1"]).optional() })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      listSaasPaymentMethods(deps.ownerDb, parsed.data.includeInactive === "1"),
    )
  })

  app.put("/methods", async (c) => {
    const actor = requireAdmin(c)
    if (!actor) return forbid(c, "Solo administración configura medios de pago")
    const parsed = z
      .object({
        code: z.string().trim().min(1).max(80),
        name: z.string().trim().min(1).max(120),
        instructions: z.string().max(2000).nullish(),
        isActive: z.boolean().optional(),
        sortOrder: z.number().int().min(0).max(100000).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runStaffWrite(
      c,
      200,
      actor,
      { action: "saas.method_saved", metadata: { code: parsed.data.code } },
      async (tx) => {
        const row = await upsertSaasPaymentMethod(tx, actor.userId, parsed.data)
        return row
      },
    )
  })

  // --- Cargos y pagos -----------------------------------------------------------------
  app.post("/charges", async (c) => {
    const actor = requireAdmin(c)
    if (!actor) return forbid(c, "Solo administración crea cargos")
    const parsed = z
      .object({
        organizationId: z.string().min(1),
        planCode: z.string().trim().min(1).max(80),
        periodStart: isoDateTime,
        periodEnd: isoDateTime,
        dueAt: isoDateTime.optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const body = parsed.data
    return runStaffWrite(
      c,
      201,
      actor,
      {
        action: "saas.charge_created",
        organizationId: body.organizationId,
        metadata: { planCode: body.planCode },
      },
      async (tx) => {
        const row = await createSaasCharge(tx, body.organizationId, actor.userId, {
          planCode: body.planCode,
          periodStart: new Date(body.periodStart),
          periodEnd: new Date(body.periodEnd),
          dueAt: body.dueAt ? new Date(body.dueAt) : undefined,
        })
        return row
      },
    )
  })

  app.get("/charges", async (c) => {
    if (!requireAdmin(c)) return forbid(c)
    const parsed = z
      .object({
        organizationId: z.string().min(1),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const query = parsed.data
    return runService(c, 200, () =>
      listSaasCharges(deps.ownerDb, query.organizationId, query.limit),
    )
  })

  app.get("/payments/pending", async (c) => {
    if (!requireAdmin(c)) return forbid(c)
    const parsed = z
      .object({ limit: z.coerce.number().int().min(1).max(200).optional() })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => listPendingSaasPayments(deps.ownerDb, parsed.data.limit))
  })

  app.post("/payments/:id/confirm", async (c) => {
    const actor = requireAdmin(c)
    if (!actor) return forbid(c, "Solo administración confirma pagos")
    const parsed = z
      .object({ organizationId: z.string().min(1) })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runStaffWrite(
      c,
      200,
      actor,
      { action: "saas.payment_confirmed", organizationId: parsed.data.organizationId },
      async (tx) => {
        const result = await confirmSaasPayment(
          tx,
          parsed.data.organizationId,
          actor.userId,
          c.req.param("id"),
        )
        return result
      },
    )
  })

  app.post("/payments/:id/reverse", async (c) => {
    const actor = requireAdmin(c)
    if (!actor) return forbid(c, "Solo administración reversa pagos")
    const parsed = z
      .object({ organizationId: z.string().min(1), reason: z.string().trim().min(1).max(2000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const body = parsed.data
    return runStaffWrite(
      c,
      200,
      actor,
      {
        action: "saas.payment_reversed",
        organizationId: body.organizationId,
        metadata: { reason: body.reason },
      },
      async (tx) => {
        const result = await reverseSaasPayment(
          tx,
          body.organizationId,
          actor.userId,
          c.req.param("id"),
          body.reason,
        )
        return result
      },
    )
  })

  app.post("/payments/:id/refund", async (c) => {
    const actor = requireAdmin(c)
    if (!actor) return forbid(c, "Solo administración devuelve pagos")
    const parsed = z
      .object({ organizationId: z.string().min(1), reason: z.string().trim().min(1).max(2000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const body = parsed.data
    return runStaffWrite(
      c,
      200,
      actor,
      {
        action: "saas.payment_refunded",
        organizationId: body.organizationId,
        metadata: { reason: body.reason },
      },
      async (tx) => {
        const result = await refundSaasPayment(
          tx,
          body.organizationId,
          actor.userId,
          c.req.param("id"),
          body.reason,
        )
        return result
      },
    )
  })
  // Staff registra un pago recibido (D1, transferencia sin upload del
  // cliente): misma submit+confirm en una tx, una sola auditoría staff.
  app.post("/payments/manual", async (c) => {
    const actor = requireAdmin(c)
    if (!actor) return forbid(c, "Solo administración registra pagos")
    const form = await c.req.formData().catch(() => null)
    if (!form) return c.json(errorBody(c, "VALIDATION", "Adjunta el comprobante"), 400)
    const field = (name: string): string | null => {
      const raw: unknown = form.get(name)
      return typeof raw === "string" ? raw : null
    }
    const organizationId = field("organizationId")
    const chargeId = field("chargeId")
    const methodCode = field("methodCode")
    const amountRaw = field("amountCents")
    const idempotencyKey = field("idempotencyKey")
    const notes = field("notes")
    const paidAtRaw = field("paidAt")
    const file: unknown = form.get("file")
    if (
      !organizationId ||
      !chargeId ||
      !methodCode ||
      !amountRaw ||
      !idempotencyKey ||
      !(file instanceof File)
    ) {
      return c.json(errorBody(c, "VALIDATION", "Faltan datos del pago"), 400)
    }
    const amountCents = Number(amountRaw)
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return c.json(errorBody(c, "VALIDATION", "El importe debe ser un entero mayor que cero"), 400)
    }
    let paidAt: Date | undefined
    if (paidAtRaw) {
      const parsed = new Date(paidAtRaw)
      if (!Number.isFinite(parsed.getTime())) {
        return c.json(errorBody(c, "VALIDATION", "Fecha de pago inválida"), 400)
      }
      paidAt = parsed
    }
    const validMime: readonly string[] = RECEIPT_UPLOAD_MIME
    if (!validMime.includes(file.type)) {
      return c.json(errorBody(c, "VALIDATION", "El comprobante debe ser PNG, JPG, WebP o PDF"), 400)
    }
    if (file.size > RECEIPT_UPLOAD_MAX_BYTES || file.size === 0) {
      return c.json(errorBody(c, "VALIDATION", "El comprobante debe pesar entre 1 B y 10 MB"), 400)
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    return runStaffWrite(
      c,
      201,
      actor,
      { action: "saas.payment_manual", organizationId, metadata: { amountCents, methodCode } },
      (tx) =>
        registerManualSaasPayment(tx, { storage: deps.storage }, organizationId, actor.userId, {
          chargeId,
          methodCode,
          amountCents,
          receipt: { bytes, contentType: file.type, filename: file.name },
          idempotencyKey,
          notes: notes ?? undefined,
          paidAt,
        }),
    )
  })

  app.get("/payments/receipt", async (c) => {
    if (!requireAdmin(c)) return forbid(c)
    const parsed = z
      .object({ organizationId: z.string().min(1), paymentId: z.string().min(1) })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const query = parsed.data
    return runService(c, 200, () =>
      getSaasReceiptUrl(
        deps.ownerDb,
        { storage: deps.storage },
        query.organizationId,
        query.paymentId,
      ),
    )
  })

  // --- Vendedores y liquidaciones ----------------------------------------------------------
  app.get("/sellers", async (c) => {
    if (!requireAdmin(c)) return forbid(c)
    const parsed = z
      .object({ includeInactive: z.enum(["0", "1"]).optional() })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      listSaasSellers(deps.ownerDb, parsed.data.includeInactive === "1"),
    )
  })

  app.put("/sellers", async (c) => {
    const actor = requireAdmin(c)
    if (!actor) return forbid(c, "Solo administración gestiona vendedores")
    const parsed = z
      .object({
        userId: z.string().min(1).nullish(),
        displayName: z.string().trim().min(1).max(120),
        rateBps: z.number().int().min(0).max(10000),
        windowDays: z.number().int().min(0).max(730).optional(),
        isActive: z.boolean().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runStaffWrite(
      c,
      200,
      actor,
      { action: "saas.seller_saved", metadata: { displayName: parsed.data.displayName } },
      async (tx) => {
        const row = await upsertSaasSeller(tx, actor.userId, parsed.data)
        return row
      },
    )
  })

  app.get("/commissions/pending", async (c) => {
    if (!requireAdmin(c)) return forbid(c)
    const parsed = z.object({ sellerId: z.string().min(1).optional() }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => listPendingSaasCommissions(deps.ownerDb, parsed.data.sellerId))
  })

  app.get("/settlements", async (c) => {
    if (!requireAdmin(c)) return forbid(c)
    const parsed = z
      .object({
        sellerId: z.string().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const query = parsed.data
    return runService(c, 200, () => listSaasSettlements(deps.ownerDb, query.sellerId, query.limit))
  })

  // Liquida y envía UN resumen por correo (dedupeKey por liquidación; en
  // repetición no hay `email` y no se reenvía nada).
  app.post("/settlements", async (c) => {
    const actor = requireAdmin(c)
    if (!actor) return forbid(c, "Solo administración liquida comisiones")
    const parsed = z
      .object({
        sellerId: z.string().min(1),
        year: z.number().int().min(2000).max(2100),
        month: z.number().int().min(1).max(12),
        currency,
        notes: z.string().max(2000).nullish(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const body = parsed.data
    try {
      // Negocio + reclamo + auditoría en una sola transacción; el SMTP va
      // después del commit y se cierra como enviado/incierto (sin reintento
      // ciego). La repetición devuelve la liquidación sin `email`: no reenvía.
      const result = await deps.ownerDb.transaction(async (tx) => {
        const settled = await settleSaasCommissions(tx, actor.userId, {
          sellerId: body.sellerId,
          year: body.year,
          month: body.month,
          currency: body.currency,
          notes: body.notes,
        })
        if (settled.email) {
          const claimed = await claimSaasNoticeMail(
            tx,
            settled.email.organizationId,
            settled.email.dedupeKey,
          )
          if (!claimed)
            throw new ServiceError("SAAS_MAIL_CLAIMED", 409, "La liquidación ya fue notificada")
        }
        await writeAdminAudit(tx, actor, {
          action: "saas.settled",
          entityId: settled.settlement.id,
          metadata: {
            sellerId: body.sellerId,
            year: body.year,
            month: body.month,
            totalCents: settled.settlement.totalCents,
          },
        })
        return settled
      })
      if (result.email) {
        try {
          await deps.mailer.send({
            to: result.email.to,
            subject: result.email.subject,
            html: result.email.html,
            text: result.email.text,
          })
          await completeSaasNoticeMail(
            deps.ownerDb,
            result.email.organizationId,
            result.email.dedupeKey,
            true,
          )
        } catch (error) {
          const detail = error instanceof Error ? error.message : "fallo de envío"
          await completeSaasNoticeMail(
            deps.ownerDb,
            result.email.organizationId,
            result.email.dedupeKey,
            false,
            detail,
          )
        }
      }
      return c.json({ data: result.settlement }, 201)
    } catch (e) {
      if (e instanceof ServiceError) {
        return c.json(errorBody(c, e.code, e.message), e.status)
      }
      throw e
    }
  })

  app.post("/settlements/:id/void", async (c) => {
    const actor = requireAdmin(c)
    if (!actor) return forbid(c, "Solo administración anula liquidaciones")
    const parsed = z
      .object({ reason: z.string().trim().min(1).max(2000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runStaffWrite(
      c,
      200,
      actor,
      {
        action: "saas.settlement_voided",
        entityId: c.req.param("id"),
        metadata: { reason: parsed.data.reason },
      },
      async (tx) => {
        await voidSaasSettlement(tx, actor.userId, c.req.param("id"), parsed.data.reason)
        return { ok: true }
      },
    )
  })

  return app
}

// --- Rutas de cuenta (panel): sesión + membresía propias ---------------------------------------

async function accountMember(deps: SaasBillingAccountDeps, c: Context, orgId: string) {
  const session = await deps.auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) return null
  const [membership] = await deps.db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.userId, session.user.id), eq(member.organizationId, orgId)))
    .limit(1)
  if (!membership) return null
  return { userId: session.user.id, role: membership.role }
}
/** Miembro que ve Facturación (`seesBilling`: owner/admin), o null (sin sesión, sin membresía u otro rol). */
async function accountOwnerOrAdmin(deps: SaasBillingAccountDeps, c: Context, orgId: string) {
  const membership = await accountMember(deps, c, orgId)
  if (!membership) return null
  if (!seesBilling(membership.role)) return null
  return membership
}

const RECEIPT_UPLOAD_MIME = ["image/png", "image/jpeg", "image/webp", "application/pdf"] as const
const RECEIPT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024

export function createAccountBillingRoute(deps: SaasBillingAccountDeps) {
  const app = new Hono()

  // Estado ligero para el launcher del panel: cualquier miembro, sin
  // importes (el saldo y el uso solo salen por /subscription con owner/admin).
  app.get("/status", async (c) => {
    const orgId = c.req.query("orgId")
    if (!orgId) return c.json(errorBody(c, "VALIDATION", "Falta la organización"), 400)
    const membership = await accountMember(deps, c, orgId)
    if (!membership)
      return c.json(errorBody(c, "FORBIDDEN", "No eres miembro de esta organización"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const summary = await getOrganizationBillingSummary(tx, orgId)
        return {
          status: summary.status,
          isDemo: summary.isDemo,
          restricted: summary.restricted,
          restrictReason: summary.restrictReason,
          pauseReason: summary.pauseReason,
          trialEndsAt: summary.trialEndsAt,
          graceEndsAt: summary.graceEndsAt,
          currentPeriodEnd: summary.currentPeriodEnd,
          planCode: summary.plan?.code ?? null,
          planName: summary.plan?.name ?? null,
          currency: summary.currency,
        }
      }),
    )
  })

  // Ficha completa con importes: solo owner/admin.
  app.get("/subscription", async (c) => {
    const orgId = c.req.query("orgId")
    if (!orgId) return c.json(errorBody(c, "VALIDATION", "Falta la organización"), 400)
    const membership = await accountMember(deps, c, orgId)
    if (!membership)
      return c.json(errorBody(c, "FORBIDDEN", "No eres miembro de esta organización"), 403)
    if (!seesBilling(membership.role)) {
      return c.json(errorBody(c, "FORBIDDEN", "Solo quien administra ve la facturación"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getOrganizationBillingSummary(tx, orgId)),
    )
  })

  app.get("/plans", async (c) => {
    const orgId = c.req.query("orgId")
    if (!orgId) return c.json(errorBody(c, "VALIDATION", "Falta la organización"), 400)
    const membership = await accountOwnerOrAdmin(deps, c, orgId)
    if (!membership)
      return c.json(errorBody(c, "FORBIDDEN", "Solo quien administra ve los planes"), 403)
    const parsed = z.object({ currency: currency.optional() }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listSaasPlans(tx, { currency: parsed.data.currency })),
    )
  })
  // C2: lo que hicieron los agentes en el tramo que corre, con sus precios (ADR 0031).
  app.get("/consumption", async (c) => {
    const orgId = c.req.query("orgId")
    if (!orgId) return c.json(errorBody(c, "VALIDATION", "Falta la organización"), 400)
    const membership = await accountOwnerOrAdmin(deps, c, orgId)
    if (!membership)
      return c.json(errorBody(c, "FORBIDDEN", "Solo quien administra ve el consumo"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const summary = await getOrganizationBillingSummary(tx, orgId)
        const sub = await getSaasSubscription(tx, orgId)
        return {
          ...(await getSaasConsumption(tx, orgId)),
          spendCapCents: sub?.spendCapCents ?? null,
          charging: isChargingPeriod(summary.status, summary.isDemo),
          whatsapp: await getWhatsappEstimate(tx, orgId),
          tax: await saasTaxOf(tx, orgId),
        }
      }),
    )
  })

  // C4: avisos de la prueba, del crédito y del tope; solo owner/admin los ve.
  app.get("/alerts", async (c) => {
    const orgId = c.req.query("orgId")
    if (!orgId) return c.json(errorBody(c, "VALIDATION", "Falta la organización"), 400)
    const membership = await accountMember(deps, c, orgId)
    if (!membership)
      return c.json(errorBody(c, "FORBIDDEN", "No eres miembro de esta organización"), 403)
    if (!seesBilling(membership.role)) return c.json({ data: [] })
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getSaasAlerts(tx, orgId)))
  })

  // C5: tope de gasto por encima del crédito.
  app.post("/spend-cap", async (c) => {
    const parsed = z
      .object({ orgId: z.string().min(1), capCents: cents.nullable() })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const membership = await accountOwnerOrAdmin(deps, c, parsed.data.orgId)
    if (!membership)
      return c.json(errorBody(c, "FORBIDDEN", "Solo quien administra cambia el tope"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, parsed.data.orgId, async (tx) => {
        await setSaasSpendCap(tx, parsed.data.orgId, membership.userId, parsed.data.capCents)
        return { ok: true }
      }),
    )
  })

  // C3: cada acción del tramo con su estado; las citas que esperan asistencia al final.
  app.get("/actions", async (c) => {
    const orgId = c.req.query("orgId")
    if (!orgId) return c.json(errorBody(c, "VALIDATION", "Falta la organización"), 400)
    const membership = await accountOwnerOrAdmin(deps, c, orgId)
    if (!membership)
      return c.json(errorBody(c, "FORBIDDEN", "Solo quien administra ve el consumo"), 403)
    const parsed = z
      .object({
        orgId: z.string(),
        kind: z.enum(["conversacion", "consulta", "cita"]).optional(),
        state: z.enum(["esperando"]).optional(),
        // El mes anterior también se ve, para pedir revisión de lo ya facturado (decisión 7).
        periodo: z.enum(["actual", "anterior"]).default("actual"),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const query = parsed.data
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const current = await currentSaasPeriod(tx, orgId)
        const previous = await previousSaasPeriod(tx, orgId, current)
        // El mes anterior ya cobrado se ve con el crédito que guardó su cargo, no con el del plan de hoy.
        const period =
          query.periodo === "anterior"
            ? { start: previous.start, end: previous.end, credit: "mes" as const, creditCents: previous.creditCents ?? current.creditCents }
            : current
        const pending = query.periodo === "anterior" ? [] : await listPendingRecoveries(tx, orgId)
        // Lo que no se cobra (anulado, dentro de una cita o devuelto) se dice en su fila, no se esconde.
        const rows =
          query.state === "esperando"
            ? pending
            : [...(await listPeriodActions(tx, orgId, period)).reverse(), ...pending].filter(
                (row) => !query.kind || row.kind === query.kind,
              )
        return {
          period: { start: period.start, end: period.end, credit: period.credit },
          previous: { start: previous.start, end: previous.end },
          total: rows.length,
          pending: pending.length,
          items: rows.slice(query.offset, query.offset + query.limit),
        }
      }),
    )
  })

  // «Pedir revisión» de una fila (ADR 0054): solo quien administra, como todo lo del cobro.
  app.post("/actions/:id/review", async (c) => {
    const parsed = z
      .object({
        orgId: z.string().min(1),
        reason: z.enum(SAAS_REVIEW_REASONS),
        note: z.string().max(1000).nullable().optional(),
        allowRead: z.boolean().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const membership = await accountOwnerOrAdmin(deps, c, parsed.data.orgId)
    if (!membership)
      return c.json(errorBody(c, "FORBIDDEN", "Solo quien administra pide revisar un cobro"), 403)
    const roleLabel = membership.role === "owner" ? "Dueño" : "Administración"
    return runService(c, 201, () =>
      withOrgContext(deps.db, parsed.data.orgId, (tx) =>
        requestActionReview(tx, parsed.data.orgId, { userId: membership.userId, roleLabel }, {
          actionId: c.req.param("id"),
          reason: parsed.data.reason,
          note: parsed.data.note ?? null,
          allowRead: parsed.data.allowRead ?? false,
        }),
      ),
    )
  })

  // Medios que configuró administración (con instrucciones reales de pago).
  app.get("/methods", async (c) => {
    const orgId = c.req.query("orgId")
    if (!orgId) return c.json(errorBody(c, "VALIDATION", "Falta la organización"), 400)
    const membership = await accountOwnerOrAdmin(deps, c, orgId)
    if (!membership)
      return c.json(errorBody(c, "FORBIDDEN", "Solo quien administra ve los medios de pago"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listSaasPaymentMethods(tx, false)),
    )
  })

  app.get("/charges", async (c) => {
    const orgId = c.req.query("orgId")
    if (!orgId) return c.json(errorBody(c, "VALIDATION", "Falta la organización"), 400)
    const membership = await accountOwnerOrAdmin(deps, c, orgId)
    if (!membership)
      return c.json(errorBody(c, "FORBIDDEN", "Solo quien administra ve los cargos"), 403)
    // Cada cargo con sus líneas: la factura suma exactamente lo que se ve (ADR 0031).
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const charges = await listSaasCharges(tx, orgId)
        const lines = await listSaasChargeLines(tx, orgId, charges.map((charge) => charge.id))
        return charges.map((charge) => ({ ...charge, lines: lines.filter((line) => line.chargeId === charge.id) }))
      }),
    )
  })

  app.get("/payments", async (c) => {
    const orgId = c.req.query("orgId")
    if (!orgId) return c.json(errorBody(c, "VALIDATION", "Falta la organización"), 400)
    const membership = await accountOwnerOrAdmin(deps, c, orgId)
    if (!membership)
      return c.json(errorBody(c, "FORBIDDEN", "Solo quien administra ve los pagos"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listSaasPayments(tx, orgId)),
    )
  })

  app.get("/usage", async (c) => {
    const orgId = c.req.query("orgId")
    if (!orgId) return c.json(errorBody(c, "VALIDATION", "Falta la organización"), 400)
    const membership = await accountOwnerOrAdmin(deps, c, orgId)
    if (!membership)
      return c.json(errorBody(c, "FORBIDDEN", "Solo quien administra ve el uso"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getSaasUsage30d(tx, orgId)),
    )
  })

  // Elegir/cambiar plan: owner/admin, disponible aun en restricción.
  app.post("/plan", async (c) => {
    const parsed = z
      .object({ orgId: z.string().min(1), planCode: z.string().trim().min(1).max(80) })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const body = parsed.data
    const membership = await accountMember(deps, c, body.orgId)
    if (!membership)
      return c.json(errorBody(c, "FORBIDDEN", "No eres miembro de esta organización"), 403)
    if (!seesBilling(membership.role)) {
      return c.json(errorBody(c, "FORBIDDEN", "Solo quien administra puede cambiar el plan"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, body.orgId, (tx) =>
        chooseSaasPlan(tx, body.orgId, membership.userId, body.planCode),
      ),
    )
  })

  // Registrar comprobante (multipart): owner/admin, disponible en restricción.
  app.post("/receipts", async (c) => {
    const form = await c.req.formData().catch(() => null)
    if (!form) return c.json(errorBody(c, "VALIDATION", "Adjunta el comprobante"), 400)
    const field = (name: string): string | null => {
      const raw: unknown = form.get(name)
      return typeof raw === "string" ? raw : null
    }
    const orgId = field("orgId")
    const chargeId = field("chargeId")
    const methodCode = field("methodCode")
    const amountRaw = field("amountCents")
    const idempotencyKey = field("idempotencyKey")
    const notes = field("notes")
    const file: unknown = form.get("file")
    if (
      !orgId ||
      !chargeId ||
      !methodCode ||
      !amountRaw ||
      !idempotencyKey ||
      !(file instanceof File)
    ) {
      return c.json(errorBody(c, "VALIDATION", "Faltan datos del comprobante"), 400)
    }
    const amountCents = Number(amountRaw)
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return c.json(errorBody(c, "VALIDATION", "El importe debe ser un entero mayor que cero"), 400)
    }
    const validMime: readonly string[] = RECEIPT_UPLOAD_MIME
    if (!validMime.includes(file.type)) {
      return c.json(errorBody(c, "VALIDATION", "El comprobante debe ser PNG, JPG, WebP o PDF"), 400)
    }
    if (file.size > RECEIPT_UPLOAD_MAX_BYTES || file.size === 0) {
      return c.json(errorBody(c, "VALIDATION", "El comprobante debe pesar entre 1 B y 10 MB"), 400)
    }
    const membership = await accountMember(deps, c, orgId)
    if (!membership)
      return c.json(errorBody(c, "FORBIDDEN", "No eres miembro de esta organización"), 403)
    if (!seesBilling(membership.role)) {
      return c.json(errorBody(c, "FORBIDDEN", "Solo quien administra registra comprobantes"), 403)
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        submitSaasReceipt(tx, { storage: deps.storage }, orgId, membership.userId, {
          chargeId,
          methodCode,
          amountCents,
          receipt: { bytes, contentType: file.type, filename: file.name },
          idempotencyKey,
          notes: notes ?? undefined,
        }),
      ),
    )
  })

  app.get("/receipts/:paymentId/url", async (c) => {
    const orgId = c.req.query("orgId")
    if (!orgId) return c.json(errorBody(c, "VALIDATION", "Falta la organización"), 400)
    const membership = await accountOwnerOrAdmin(deps, c, orgId)
    if (!membership)
      return c.json(errorBody(c, "FORBIDDEN", "Solo quien administra ve el comprobante"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getSaasReceiptUrl(tx, { storage: deps.storage }, orgId, c.req.param("paymentId")),
      ),
    )
  })

  return app
}

/**
 * Guard comercial con db explícita (sin contexto mágico). El padre monta el
 * cierre tras el guard de org, omitiendo GET/HEAD, ayuda y lecturas con flag
 * de usuario:
 * `guarded.use("/ruta/*", (c, next) => requireSaasAccess(deps.db, "operar")(c, next))`.
 * Nunca en `/api/account/billing`, `/api/account/support`, webhooks ni
 * ingesta. El ServiceError (SAAS_RESTRICTED) lo mapea el onError central.
 * Los bloqueos de identidad son independientes de la suscripción.
 */
export function requireSaasAccess(db: Db, operation: SaasOperation) {
  return async (c: Context, next: () => Promise<void>) => {
    const orgId = c.get("orgId") as string | undefined
    if (!orgId) {
      return c.json(errorBody(c, "ORG_REQUIRED", "No hay organización activa"), 403)
    }
    await withOrgContext(db, orgId, (tx) => assertSaasAllowed(tx, orgId, operation))
    await next()
  }
}

export async function readSaasDecision(db: Db, orgId: string, operation: SaasOperation) {
  return withOrgContext(db, orgId, (tx) => decideSaasAccess(tx, orgId, operation))
}

export async function readSaasSubscription(db: Db, orgId: string) {
  return withOrgContext(db, orgId, (tx) => getSaasSubscription(tx, orgId))
}
/**
 * Guard previo al `auth.handler` de Better Auth (el padre lo monta ANTES de
 * `app.on(["GET", "POST"], "/api/auth/*", ...)` porque esas rutas no pasan
 * por `guarded`). Solo inspecciona `POST /api/auth/organization/*`:
 *
 * - Pasan siempre (aun en restricción/pausa comercial): lecturas,
 *   `set-active`, `remove-member`, `leave`, `cancel-invitation`,
 *   `reject-invitation`, `update-member-role` (no suma asientos; permite
 *   recuperar el control), `update` (renombrar no es operar) y `delete`
 *   (darse de baja no se bloquea por deuda). La pausa/bloqueo de SEGURIDAD
 *   se gestiona por identidad: aquí nunca se levanta al pagar.
 * - `invite-member` y `accept-invitation` (suman asientos) exigen estar al
 *   día comercial y cupo en el plan (`SAAS_RESTRICTED` / `SAAS_SEAT_LIMIT`).
 *   Refuerzo contra races en DB (`saas_seat_cap_*`, `0001_base_reglas.sql`).
 * - Tras un `create` 2xx, `startSaasTrial` rellena plan/datos en la fila que
 *   ya dejó el trigger `saas_trial_on_org_create` en la misma transacción
 *   (garantía real; databaseHooks no cubre el modelo organization).
 *
 * Recovery (`/reset-password`, `/verify-email`), webhooks e ingesta no se
 * tocan: este middleware no los mira.
 */
export interface SaasPreAuthDeps {
  auth: Auth
  ownerDb: Db
}
const PRE_AUTH_PREFIX = "/api/auth/organization/"
export function createSaasPreAuthGuard(deps: SaasPreAuthDeps) {
  return async (c: Context, next: () => Promise<void>) => {
    const path = c.req.path
    if (!path.startsWith(PRE_AUTH_PREFIX) || c.req.method !== "POST") return next()
    const tail = path.slice(PRE_AUTH_PREFIX.length)
    if (tail === "invite-member" || tail === "accept-invitation") {
      const body: unknown = await c.req.raw
        .clone()
        .json()
        .catch(() => null)
      const target = await resolvePreAuthTarget(deps.ownerDb, tail, body)
      // Sin sesión no se revela nada comercial: Better Auth denegará solo.
      const session = await deps.auth.api.getSession({ headers: c.req.raw.headers })
      if (!session) return c.json(errorBody(c, "UNAUTHORIZED", "Sesión requerida"), 401)
      if (target && (await preAuthCallerAllowed(deps, session.user, tail, target))) {
        // SAAS_RESTRICTED/SAAS_SEAT_LIMIT suben al onError central del padre.
        // Se excluye el correo que se suma: aceptar al límite exacto pasa.
        await decidePreAuthInvite(deps.ownerDb, target.organizationId, target.email)
      }
      return next()
    }
    if (tail !== "create") return next()
    await next()
    const status = c.res.status
    if (status < 200 || status >= 300) return
    const createdId = await readCreatedOrgId(c.res.clone())
    if (!createdId) {
      console.error(`saas-billing: create sin id legible; la prueba se asegura al abrir billing`)
      return
    }
    try {
      await startSaasTrial(deps.ownerDb, createdId, {})
    } catch (e) {
      console.error(`saas-billing: no se pudo iniciar la prueba de ${createdId}`, e)
    }
  }
}
interface PreAuthTarget {
  organizationId: string
  email: string | null
}
async function resolvePreAuthTarget(
  ownerDb: Db,
  tail: string,
  body: unknown,
): Promise<PreAuthTarget | null> {
  if (typeof body !== "object" || body === null) return null
  if (tail === "invite-member") {
    if (!("organizationId" in body)) return null
    const organizationId: unknown = body.organizationId
    if (typeof organizationId !== "string" || !organizationId) return null
    const email: unknown = "email" in body ? body.email : null
    return { organizationId, email: typeof email === "string" && email ? email : null }
  }
  if (!("invitationId" in body)) return null
  const invitationId: unknown = body.invitationId
  if (typeof invitationId !== "string" || !invitationId) return null
  const [row] = await ownerDb
    .select({ organizationId: invitation.organizationId, email: invitation.email })
    .from(invitation)
    .where(eq(invitation.id, invitationId))
    .limit(1)
  if (!row) return null
  return { organizationId: row.organizationId, email: row.email }
}
async function decidePreAuthInvite(
  ownerDb: Db,
  organizationId: string,
  email: string | null,
): Promise<void> {
  await assertSaasAllowed(ownerDb, organizationId, "operar")
  await assertSaasSeatAvailable(ownerDb, organizationId, email ?? undefined)
}
/**
 * ¿Se corre el chequeo comercial? Evita el side channel: invitar exige ser
 * owner/admin de la org; aceptar exige ser la cuenta invitada con correo
 * verificado. `false` = pasar sin chequear (Better Auth decide después).
 */
async function preAuthCallerAllowed(
  deps: SaasPreAuthDeps,
  caller: unknown,
  tail: string,
  target: PreAuthTarget,
): Promise<boolean> {
  if (typeof caller !== "object" || caller === null) return false
  if (!("id" in caller) || !("email" in caller)) return false
  const callerId: unknown = caller.id
  const callerEmail: unknown = caller.email
  if (typeof callerId !== "string" || typeof callerEmail !== "string") return false
  if (tail === "accept-invitation") {
    if (!target.email) return false
    if (callerEmail.trim().toLowerCase() !== target.email.trim().toLowerCase()) return false
    if ("emailVerified" in caller && caller.emailVerified !== true) return false
    return true
  }
  const [membership] = await deps.ownerDb
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.userId, callerId), eq(member.organizationId, target.organizationId)))
    .limit(1)
  return membership?.role === "owner" || membership?.role === "admin"
}
async function readCreatedOrgId(res: Response): Promise<string | null> {
  const body: unknown = await res.json().catch(() => null)
  if (typeof body !== "object" || body === null) return null
  const candidates: unknown[] = [body]
  if ("organization" in body) candidates.push(body.organization)
  if ("data" in body) candidates.push(body.data)
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue
    if (!("id" in candidate)) continue
    const id: unknown = candidate.id
    if (typeof id === "string" && id) return id
  }
  return null
}
