import { withOrgContext } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import {
  issuePortalLink,
  listPortalLinks,
  revokePortalLink,
  revokePortalSession,
} from "@odentia/services"
import { eq } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const scopeInput = z
  .object({
    appointments: z.boolean().optional(),
    budgets: z.boolean().optional(),
    account: z.boolean().optional(),
    documentIds: z.array(z.uuid()).max(100).optional(),
  })
  .strict()

const issueInput = z
  .object({
    patientId: z.uuid(),
    contactId: z.uuid(),
    conversationId: z.uuid(),
    scope: scopeInput,
    ttlHours: z.number().int().min(1).max(720).optional(),
    idempotencyKey: z.string().trim().min(8).max(128).optional(),
  })
  .strict()

/**
 * Emisión staff de accesos al portal (UI en `/_org/patient-access`).
 * Montaje del padre: `guarded.route("/portal", createPortalRoute(...))`
 * (rutas internas sin prefijo: /links, /links/:id/revoke, /sessions/:id/revoke).
 * - Requiere `patients.write`; documentos exige además `clinical.read`;
 *   alcance financiero (presupuestos/cuenta) exige `finance.read`.
 * - El token crudo jamás se devuelve: se entrega por la conversación
 *   indicada del contacto; la respuesta trae metadata + entrega + PIN único.
 */
export function createPortalRoute(deps: Pick<CrmDeps, "db"> & { webURL: string; cookieDomain: string }) {
  const app = new Hono()

  function deny(c: Context, permission: string) {
    return c.json(
      errorBody(c, "FORBIDDEN", `Necesitas el permiso ${permission} para el portal`),
      403,
    )
  }


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
    const web = new URL(deps.webURL)
    if (org?.slug) {
      const domain = deps.cookieDomain.startsWith(".") ? deps.cookieDomain.slice(1) : deps.cookieDomain
      if (domain) web.hostname = `${org.slug}.${domain}`
    }
    const base = web.toString().replace(/\/$/, "")
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
