import { withOrgContext } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import {
  changePortalAccess,
  getPortalAccessSummary,
  getPortalPolicy,
  givePortalAccess,
  type PortalShareRights,
  resendPortalAccess,
  revokePortalGrant,
  upsertPortalPolicy,
} from "@odentia/services"
import { eq } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { portalOrigin } from "../lib/portal-origin.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"
import { portalAccessInput, portalIdInput, portalPolicyInput, portalScopeInput } from "./portal-input.js"

/**
 * El portal del paciente desde la página de la persona (Datos › Acceso al
 * portal) y su configuración. Un solo paso (decisión 9, ADR 0037): «Dar
 * acceso», «Cambiar», «Enviar nuevo enlace» y «Quitar acceso».
 * - Requiere `patients.write`. Compartir presupuestos, quien puede enviarlos
 *   (recepción incluida, decisión 4); la cuenta, quien ve la caja; los
 *   documentos, quien lee la historia.
 * - El token crudo solo viaja en el QR (una vez) o en el mensaje a la persona;
 *   el código de 6 dígitos vuelve a quien da el acceso, para decírselo aparte.
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
  }

  function deny(c: Context, permission: string) {
    return c.json(
      errorBody(c, "FORBIDDEN", DENIED[permission] ?? "No tienes permiso para hacer esto en el portal"),
      403,
    )
  }

  /** Lo que quien da el acceso puede compartir: lo comprueba el servicio con el alcance pedido. */
  function rightsOf(c: Context): PortalShareRights {
    const { memberRole } = orgContextOf(c)
    return {
      canShareBudgets: canAccess(memberRole, "budgets.send") || canAccess(memberRole, "finance.read"),
      canShareAccount: canAccess(memberRole, "finance.read"),
      canShareDocuments: canAccess(memberRole, "clinical.read"),
    }
  }

  async function linkUrl(orgId: string): Promise<((token: string) => string) | null> {
    const [org] = await deps.db.select({ slug: organization.slug }).from(organization).where(eq(organization.id, orgId)).limit(1)
    if (!org?.slug) return null
    const base = portalOrigin(deps, org.slug)
    return (token: string) => `${base}/portal?token=${token}`
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

  // La fila de acceso de la persona y a quién se le puede dar.
  app.get("/access", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const query = z.object({ patientId: z.uuid() }).safeParse(c.req.query())
    if (!query.success) return validationError(c, query.error.issues)
    return runService(c, 200, async () => ({
      ...(await withOrgContext(deps.db, orgId, (tx) => getPortalAccessSummary(tx, orgId, query.data.patientId))),
      rights: rightsOf(c),
    }))
  })

  app.post("/access", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const parsed = portalAccessInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const url = await linkUrl(orgId)
    if (!url) return c.json(errorBody(c, "NOT_FOUND", "Organización no disponible"), 404)
    const { patientId, ...input } = parsed.data
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => givePortalAccess(tx, orgId, userId, patientId, input, { linkUrl: url, ...rightsOf(c) })),
    )
  })

  app.patch("/access/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const params = portalIdInput.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = z.strictObject({ scope: portalScopeInput }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => changePortalAccess(tx, orgId, userId, params.data.id, parsed.data, rightsOf(c))),
    )
  })

  // «Enviar nuevo enlace»: para volver a entrar, sin volver a comprobar su identidad.
  app.post("/access/:id/resend", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const params = portalIdInput.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = z.strictObject({ delivery: z.enum(["qr", "whatsapp"]) }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const url = await linkUrl(orgId)
    if (!url) return c.json(errorBody(c, "NOT_FOUND", "Organización no disponible"), 404)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        resendPortalAccess(tx, orgId, userId, params.data.id, parsed.data, { linkUrl: url, ...rightsOf(c) }),
      ),
    )
  })

  // «Quitar acceso» cierra todo: sesiones, llaves y enlaces.
  app.post("/access/:id/revoke", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) return deny(c, "patients.write")
    const params = portalIdInput.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => revokePortalGrant(tx, orgId, userId, params.data.id, "Quitó el acceso desde la página de la persona")),
    )
  })

  return app
}
