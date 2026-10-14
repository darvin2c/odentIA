import { withOrgContext } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import {
  issuePortalLink,
  listPortalLinks,
  revokePortalLink,
  revokePortalSession,
  getPortalPolicy, upsertPortalPolicy, listPortalRequests, approvePortalRequest,
  rejectPortalRequest, createPortalGrant, listPortalGrants, revokePortalGrant,
  listPortalSessions, listPortalPasskeys, revokePortalPasskey,
  issuePortalActivationQr,
} from "@odentia/services"
import { eq } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { portalOrigin } from "../lib/portal-origin.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

import { portalScopeInput, portalGrantInput, portalPolicyInput, portalIdInput } from "./portal-input.js"

const issueInput = z
  .object({
    patientId: z.uuid(),
    contactId: z.uuid(),
    conversationId: z.uuid(),
    scope: portalScopeInput,
    ttlHours: z.number().int().min(1).max(720).optional(),
    idempotencyKey: z.string().trim().min(8).max(128).optional(),
  })
  .strict()

/**
 * Emisión staff de accesos al portal desde la ficha del paciente.
 * Montaje del padre: `guarded.route("/portal", createPortalRoute(...))`
 * (rutas internas sin prefijo: /links, /links/:id/revoke, /sessions/:id/revoke).
 * - Requiere `patients.write`; documentos exige además `clinical.read`;
 *   alcance financiero (presupuestos/cuenta) exige `finance.read`.
 * - El token crudo jamás se devuelve: se entrega por la conversación
 *   indicada del contacto; la respuesta trae metadata + entrega + PIN único.
 */
export function createPortalRoute(deps: Pick<CrmDeps, "db"> & { webURL: string; cookieDomain: string }) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    await next()
  })

  /** Por qué no puede, dicho con palabras: el código del permiso no llega a la pantalla. */
  const DENIED: Record<string, string> = {
    "settings.read": "El portal del paciente lo configura quien administra la clínica",
    "settings.write": "El portal del paciente lo configura quien administra la clínica",
    "patients.write": "El acceso de un paciente al portal lo gestiona quien puede editar su ficha",
    "clinical.read": "Solo quien ve la ficha clínica puede dar acceso a sus documentos",
    "finance.read": "Solo quien ve los cobros puede dar acceso a presupuestos o a la cuenta",
  }

  function deny(c: Context, permission: string) {
    return c.json(
      errorBody(c, "FORBIDDEN", DENIED[permission] ?? "No tienes permiso para hacer esto en el portal"),
      403,
    )
  }

  app.get("/policy", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.read")) return deny(c, "settings.read")
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => getPortalPolicy(tx, orgId)))
  })

  app.put("/policy", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) return deny(c, "settings.write")
    const parsed = portalPolicyInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => upsertPortalPolicy(tx, orgId, userId, parsed.data)))
  })

  function scopeDenied(c: Context, scope: z.infer<typeof portalScopeInput>) {
    const { memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    if (scope.documentIds?.length && !canAccess(memberRole, "clinical.read")) return deny(c, "clinical.read")
    if ((scope.budgets || scope.account) && !canAccess(memberRole, "finance.read")) return deny(c, "finance.read")
    return null
  }

  app.get("/requests", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const parsed = z.object({ status: z.enum(["pendiente", "aprobada", "rechazada", "expirada"]).optional() }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => listPortalRequests(tx, orgId, parsed.data.status)))
  })

  app.post("/requests/:id/approve", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const params = portalIdInput.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = portalGrantInput.extend({ conversationId: z.uuid() }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const denied = scopeDenied(c, parsed.data.scope)
    if (denied) return denied
    const [org] = await deps.db.select({ slug: organization.slug }).from(organization).where(eq(organization.id, orgId)).limit(1)
    if (!org?.slug) return c.json(errorBody(c, "NOT_FOUND", "Organización no disponible"), 404)
    const base = portalOrigin(deps, org.slug)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => approvePortalRequest(tx, orgId, userId, params.data.id, {
      ...parsed.data, deliver: { linkUrl: token => `${base}/portal?token=${token}`, canShareFinance: canAccess(memberRole, "finance.read") },
    })))
  })

  app.post("/requests/:id/reject", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const params = portalIdInput.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = z.strictObject({ note: z.string().trim().max(1000).optional() }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => rejectPortalRequest(tx, orgId, userId, params.data.id, parsed.data.note)))
  })

  app.post("/grants", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const parsed = portalGrantInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const denied = scopeDenied(c, parsed.data.scope)
    if (denied) return denied
    return runService(c, 201, () => withOrgContext(deps.db, orgId, tx => createPortalGrant(tx, orgId, userId, parsed.data)))
  })

  app.get("/grants", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const parsed = z.object({ patientId: z.uuid().optional() }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => listPortalGrants(tx, orgId, parsed.data.patientId)))
  })

  app.post("/grants/:id/revoke", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const params = portalIdInput.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = z.strictObject({ reason: z.string().trim().max(1000).optional() }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => revokePortalGrant(tx, orgId, userId, params.data.id, parsed.data.reason)))
  })

  app.get("/sessions", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const parsed = z.object({ patientId: z.uuid().optional(), contactId: z.uuid().optional(), grantId: z.uuid().optional() }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => listPortalSessions(tx, orgId, parsed.data)))
  })

  app.get("/passkeys", async c => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const parsed = z.object({ contactId: z.uuid() }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => listPortalPasskeys(tx, orgId, parsed.data.contactId)))
  })

  app.post("/passkeys/:id/revoke", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const parsed = portalIdInput.safeParse(c.req.param())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => revokePortalPasskey(tx, orgId, userId, parsed.data.id)))
  })

  app.post("/activations/qr", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const parsed = issueInput.omit({ conversationId: true }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const denied = scopeDenied(c, parsed.data.scope)
    if (denied) return denied
    const [org] = await deps.db.select({ slug: organization.slug }).from(organization).where(eq(organization.id, orgId)).limit(1)
    if (!org?.slug) return c.json(errorBody(c, "NOT_FOUND", "Organización no disponible"), 404)
    const base = portalOrigin(deps, org.slug)
    c.header("Cache-Control", "no-store")
    return runService(c, 201, () => withOrgContext(deps.db, orgId, async tx => {
      const issued = await issuePortalActivationQr(tx, orgId, userId, parsed.data)
      return { link: issued.link, activationUrlOnce: `${base}/portal?token=${issued.rawTokenOnce}`, pinOnce: issued.pinOnce }
    }))
  })


  app.post("/links", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const parsed = issueInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    if ((parsed.data.scope.documentIds?.length ?? 0) > 0 && !canAccess(memberRole, "clinical.read")) {
      return deny(c, "clinical.read")
    }
    const needsFinance = parsed.data.scope.budgets === true || parsed.data.scope.account === true
    if (needsFinance && !canAccess(memberRole, "finance.read")) {
      return deny(c, "finance.read")
    }
    const [org] = await deps.db
      .select({ slug: organization.slug })
      .from(organization)
      .where(eq(organization.id, orgId))
      .limit(1)
    if (!org?.slug) return c.json(errorBody(c, "NOT_FOUND", "Organización no disponible"), 404)
    const base = portalOrigin(deps, org.slug)
    const canShareFinance = canAccess(memberRole, "finance.read")
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        issuePortalLink(tx, orgId, userId, parsed.data, {
          linkUrl: (rawLinkToken) => `${base}/portal?token=${rawLinkToken}`,
          canShareFinance,
        }),
      ),
    )
  })

  app.get("/links", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const query = z.object({ patientId: z.uuid().optional() }).safeParse(c.req.query())
    if (!query.success) return validationError(c, query.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listPortalLinks(tx, orgId, query.data.patientId)),
    )
  })

  app.patch("/links/:id/revoke", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => revokePortalLink(tx, orgId, userId, params.data.id)),
    )
  })

  app.patch("/sessions/:id/revoke", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => revokePortalSession(tx, orgId, userId, params.data.id)),
    )
  })

  return app
}
