import { CLINICAL_PRODUCTS, type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { organization, user } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import { invitationTemplate } from "@odentia/mail"
import {
  type AssistedOrganizationResult,
  approveRecoveryCase,
  getOrganizationBillingTerms,
  setSaasBillingCycle,
  setSaasDiscount,
  setSaasTrialTerms,
  cancelOrganizationInvitation,
  closeAccountByAdmin,
  createAssistedOrganization,
  executeRecoveryCase,
  getOrganizationDetail,
  getOrganizationPendingCounts,
  getUserDetail,
  listOrganizations,
  listRecoveryCases,
  type OrganizationBillingLoaders,
  type OrgInvitationItem,
  openRecoveryCase,
  type RecoveryEffect,
  removeGlobalBlock,
  resendOrganizationInvitation,
  revokeUserSessions,
  ServiceError,
  searchUsers,
  setGlobalBlock,
  writeAdminAudit,
} from "@odentia/services"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppDeps } from "../app.js"
import { adminContextOf, forbidUnlessManager } from "../lib/admin-context.js"
import { errorBody } from "../lib/error.js"
import { runService, serviceErrorResponse, validationError } from "./helpers.js"

export interface AdminOrganizationsDeps
  extends Pick<AppDeps, "auth" | "ownerDb" | "mailer" | "webURL"> {
  /** El panel de cada producto: la invitación se acepta en el dominio de la clínica. */
  panelUrlOf?: (product: ClinicalProduct) => string
  getBillingSummary?: OrganizationBillingLoaders["getBillingSummary"]
  startTrial?: OrganizationBillingLoaders["startTrial"]
}

const pageQuery = z.object({
  q: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})
const organizationQuery = pageQuery.extend({
  /** Solo las clínicas con precio negociado vigente (issue 168). */
  negotiated: z.enum(["1"]).optional(),
})

const userQuery = pageQuery.extend({
  status: z.enum(["todos", "activos", "bloqueados", "sin_verificar", "sin_clinica"]).optional(),
})

const assistedInput = z.object({
  orgName: z.string().trim().min(2).max(120),
  slug: z.string().trim().min(2).max(63),
  email: z.string().trim().email().max(320),
  countryCode: z.string().trim().length(2),
  currency: z.string().trim().length(3).optional(),
  timezone: z.string().trim().max(60).optional(),
  billingStart: z.enum(["trial", "now"]).optional(),
  planCode: z.string().trim().min(1).max(60).optional(),
  sellerId: z.string().trim().max(120).optional(),
  isDemo: z.boolean().optional(),
  product: z.enum(CLINICAL_PRODUCTS).optional(),
})

const blockInput = z.object({
  reason: z.string().trim().min(10).max(500),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
})

const closeInput = z.object({ reason: z.string().trim().min(10).max(500) })

const revokeInput = z.object({ token: z.string().min(1).max(500).optional() })

const evidenceInput = z.object({
  description: z.string().trim().min(10).max(2000),
  verifiedBy: z.string().trim().min(1).max(200),
  verifiedAt: z.string().trim().min(1).max(100),
  method: z.string().trim().min(5).max(500),
  organizationId: z.string().trim().max(120).optional(),
})

const recoveryOpenInput = z.object({
  email: z.string().trim().email().max(320),
  kind: z.enum(["acceso", "propiedad"]),
  evidence: evidenceInput,
})

const recoveryDecisionInput = z.object({
  decision: z.enum(["aprobar", "rechazar"]),
  note: z.string().trim().max(500).optional(),
})

/**
 * Administración de organizaciones y usuarios (`/api/admin/organizations`,
 * con guard `requireAdminContext` delante). Rutas relativas al namespace.
 * Por acción se comprueba el rol: soporte lee, crea altas asistidas,
 * invita/reenvía y abre casos; solo admin bloquea, cierra cuentas, decide y
 * ejecuta recuperaciones. El personal nunca cambia roles de clínica.
 */
export function createAdminOrganizationsRoute(deps: AdminOrganizationsDeps) {
  const app = new Hono()
  const loaders: OrganizationBillingLoaders = {
    getBillingSummary: deps.getBillingSummary,
    startTrial: deps.startTrial,
  }

  function owner<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return deps.ownerDb.transaction((tx) => fn(tx as Db))
  }

  async function staffName(userId: string): Promise<string> {
    const [row] = await deps.ownerDb
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)
    return row?.name?.trim() || "El equipo de odentIA"
  }

  async function sendInviteEmail(args: {
    email: string
    organizationName: string
    invitationId: string
    inviterName: string
    /** El de la clínica: la invitación se acepta en el panel de su dominio. */
    product: ClinicalProduct
  }): Promise<void> {
    const panel = deps.panelUrlOf?.(args.product) ?? deps.webURL
    const template = invitationTemplate({
      organizationName: args.organizationName,
      inviterName: args.inviterName,
      url: `${panel}/accept-invitation/${args.invitationId}`,
    })
    await deps.mailer.send({ to: args.email, ...template })
  }

  async function productOf(organizationId: string): Promise<ClinicalProduct> {
    const [row] = await deps.ownerDb
      .select({ product: orgProfile.product })
      .from(orgProfile)
      .where(eq(orgProfile.organizationId, organizationId))
      .limit(1)
    return isClinicalProduct(row?.product) ? row.product : "dental"
  }

  async function orgNameOf(organizationId: string): Promise<string> {
    const [row] = await deps.ownerDb
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1)
    return row?.name ?? "tu clínica"
  }

  app.get("/", async (c) => {
    const actor = adminContextOf(c)
    const parsed = organizationQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      owner((tx) =>
        listOrganizations(
          tx,
          actor,
          { q: parsed.data.q, limit: parsed.data.limit, offset: parsed.data.offset, negotiated: parsed.data.negotiated === "1" },
          loaders,
        ),
      ),
    )
  })

  app.get("/pending-counts", async (c) => {
    const actor = adminContextOf(c)
    return runService(c, 200, () => owner((tx) => getOrganizationPendingCounts(tx, actor)))
  })

  app.post("/assisted", async (c) => {
    const actor = adminContextOf(c)
    const parsed = assistedInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    let created: AssistedOrganizationResult
    try {
      created = await owner((tx) =>
        createAssistedOrganization(
          tx,
          actor,
          {
            orgName: parsed.data.orgName,
            slug: parsed.data.slug,
            email: parsed.data.email,
            countryCode: parsed.data.countryCode,
            currency: parsed.data.currency,
            timezone: parsed.data.timezone,
            billingStart: parsed.data.billingStart,
            planCode: parsed.data.planCode,
            sellerId: parsed.data.sellerId,
            isDemo: parsed.data.isDemo,
            product: parsed.data.product,
          },
          loaders,
        ),
      )
    } catch (e) {
      const mapped = serviceErrorResponse(c, e)
      if (mapped) return mapped
      throw e
    }
    if (created.invitationId) {
      try {
        await sendInviteEmail({
          email: parsed.data.email,
          organizationName: parsed.data.orgName,
          invitationId: created.invitationId,
          inviterName: await staffName(actor.userId),
          product: parsed.data.product ?? "dental",
        })
      } catch {
        throw new ServiceError(
          "EMAIL_FAILED",
          502,
          "Clínica creada e invitación lista, pero no se pudo enviar el correo: reenvíalo desde la ficha",
        )
      }
    }
    return c.json({ data: created }, 201)
  })

  app.get("/users", async (c) => {
    const actor = adminContextOf(c)
    const parsed = userQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      owner((tx) =>
        searchUsers(tx, actor, {
          q: parsed.data.q,
          status: parsed.data.status,
          limit: parsed.data.limit,
          offset: parsed.data.offset,
        }),
      ),
    )
  })

  app.get("/users/:id", async (c) => {
    const actor = adminContextOf(c)
    return runService(c, 200, () => owner((tx) => getUserDetail(tx, actor, c.req.param("id"))))
  })

  /** Recuperar acceso: envía el flujo existente de restablecimiento. */
  app.post("/users/:id/access-recovery", async (c) => {
    const actor = adminContextOf(c)
    const userId = c.req.param("id")
    let email: string
    try {
      const detail = await owner((tx) => getUserDetail(tx, actor, userId))
      if (detail.blocked) {
        throw new ServiceError(
          "FORBIDDEN",
          403,
          "La cuenta está bloqueada: retira el bloqueo antes de recuperar el acceso",
        )
      }
      email = detail.email
    } catch (e) {
      const mapped = serviceErrorResponse(c, e)
      if (mapped) return mapped
      throw e
    }
    try {
      await deps.auth.api.requestPasswordReset({
        headers: c.req.raw.headers,
        body: { email },
      })
    } catch {
      throw new ServiceError("EMAIL_FAILED", 502, "No se pudo enviar el correo de recuperación")
    }
    return runService(c, 200, async () => {
      await owner((tx) =>
        writeAdminAudit(tx, actor, {
          action: "user.access_recovery_sent",
          organizationId: null,
          entityId: userId,
          metadata: { email },
        }),
      )
      return { ok: true }
    })
  })

  app.post("/users/:id/sessions/revoke", async (c) => {
    const actor = adminContextOf(c)
    const parsed = revokeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      owner((tx) => revokeUserSessions(tx, actor, c.req.param("id"), parsed.data.token)),
    )
  })

  app.post("/users/:id/block", async (c) => {
    const actor = adminContextOf(c)
    const denied = forbidUnlessManager(c, actor)
    if (denied) return denied
    const parsed = blockInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      owner((tx) =>
        setGlobalBlock(tx, actor, {
          userId: c.req.param("id"),
          reason: parsed.data.reason,
          expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : undefined,
        }),
      ).then(() => ({ ok: true })),
    )
  })

  app.delete("/users/:id/block", async (c) => {
    const actor = adminContextOf(c)
    const denied = forbidUnlessManager(c, actor)
    if (denied) return denied
    return runService(c, 200, () =>
      owner((tx) => removeGlobalBlock(tx, actor, c.req.param("id"))).then(() => ({ ok: true })),
    )
  })
  app.post("/users/:id/close", async (c) => {
    const actor = adminContextOf(c)
    const denied = forbidUnlessManager(c, actor)
    if (denied) return denied
    const parsed = closeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      owner((tx) =>
        closeAccountByAdmin(tx, actor, { userId: c.req.param("id"), reason: parsed.data.reason }),
      ).then(() => ({ ok: true })),
    )
  })

  app.get("/recovery-cases", async (c) => {
    const actor = adminContextOf(c)
    const status = c.req.query("status") || undefined
    return runService(c, 200, () => owner((tx) => listRecoveryCases(tx, actor, { status })))
  })

  app.post("/recovery-cases", async (c) => {
    const actor = adminContextOf(c)
    const parsed = recoveryOpenInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      owner((tx) =>
        openRecoveryCase(tx, actor, {
          email: parsed.data.email,
          kind: parsed.data.kind,
          evidence: parsed.data.evidence,
        }),
      ),
    )
  })

  app.post("/recovery-cases/:id/approvals", async (c) => {
    const actor = adminContextOf(c)
    const parsed = recoveryDecisionInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      owner((tx) =>
        approveRecoveryCase(tx, actor, {
          id: c.req.param("id"),
          decision: parsed.data.decision,
          note: parsed.data.note,
        }),
      ),
    )
  })

  app.post("/recovery-cases/:id/execute", async (c) => {
    const actor = adminContextOf(c)
    const denied = forbidUnlessManager(c, actor)
    if (denied) return denied
    let effect: RecoveryEffect
    try {
      effect = await owner((tx) => executeRecoveryCase(tx, actor, c.req.param("id")))
    } catch (e) {
      const mapped = serviceErrorResponse(c, e)
      if (mapped) return mapped
      throw e
    }
    if (effect.kind === "acceso") {
      try {
        await deps.auth.api.requestPasswordReset({
          headers: c.req.raw.headers,
          body: { email: effect.email },
        })
      } catch {
        throw new ServiceError(
          "EMAIL_FAILED",
          502,
          "Caso ejecutado, pero no se pudo enviar el restablecimiento: usa «Recuperar acceso» en la ficha",
        )
      }
    }
    return c.json({ data: effect }, 200)
  })

  app.post("/invitations/:id/resend", async (c) => {
    const actor = adminContextOf(c)
    const invitationId = c.req.param("id")
    let resent: OrgInvitationItem
    try {
      resent = await owner((tx) => resendOrganizationInvitation(tx, actor, invitationId))
    } catch (e) {
      const mapped = serviceErrorResponse(c, e)
      if (mapped) return mapped
      throw e
    }
    try {
      await sendInviteEmail({
        email: resent.email,
        organizationName: await orgNameOf(resent.organizationId),
        invitationId: resent.id,
        inviterName: await staffName(actor.userId),
        product: await productOf(resent.organizationId),
      })
    } catch {
      throw new ServiceError(
        "EMAIL_FAILED",
        502,
        "Invitación renovada, pero no se pudo enviar el correo",
      )
    }
    return c.json({ data: resent }, 200)
  })

  app.post("/invitations/:id/cancel", async (c) => {
    const actor = adminContextOf(c)
    return runService(c, 200, () =>
      owner((tx) => cancelOrganizationInvitation(tx, actor, c.req.param("id"))).then(() => ({
        ok: true,
      })),
    )
  })

  // O2: cobro y consumo de la clínica (ADR 0031). Lo ve todo el personal; negociar fuera de lo de siempre pide aprobación.
  app.get("/:id/billing", async (c) => {
    adminContextOf(c)
    return runService(c, 200, () => owner((tx) => getOrganizationBillingTerms(tx, c.req.param("id"))))
  })

  app.post("/:id/billing/discount", async (c) => {
    const actor = adminContextOf(c)
    const parsed = z
      .object({
        discountBps: z.number().int().min(0).max(9000),
        /** Último instante del descuento (issue 168); null o ausente = no vence. */
        discountEndsAt: z.iso.datetime({ offset: true }).nullish(),
        note: z.string().max(500).nullish(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { discountEndsAt, ...rest } = parsed.data
    return runService(c, 200, () =>
      owner((tx) => setSaasDiscount(tx, actor, c.req.param("id"), { ...rest, discountEndsAt: discountEndsAt ? new Date(discountEndsAt) : null })),
    )
  })

  app.post("/:id/billing/trial", async (c) => {
    const actor = adminContextOf(c)
    const parsed = z
      .object({
        trialCreditCents: z.number().int().min(0).max(100_000_000),
        trialDays: z.number().int().min(1).max(365),
        note: z.string().max(500).nullish(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => owner((tx) => setSaasTrialTerms(tx, actor, c.req.param("id"), parsed.data)))
  })

  app.post("/:id/billing/cycle", async (c) => {
    const actor = adminContextOf(c)
    const parsed = z
      .object({ cycle: z.enum(["mensual", "quincenal"]) })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      owner(async (tx) => {
        await setSaasBillingCycle(tx, actor, c.req.param("id"), parsed.data.cycle)
        return { ok: true }
      }),
    )
  })

  // Ficha completa al final: evita que `/:id` capture rutas literales.
  app.get("/:id", async (c) => {
    const actor = adminContextOf(c)
    return runService(c, 200, () =>
      owner((tx) => getOrganizationDetail(tx, actor, c.req.param("id"), loaders)),
    )
  })

  return app
}
