import { withOrgContext } from "@odentia/db"
import {
  clinicAddressOf,
  getPortalAccessSummary,
  getPortalPolicy,
  givePortalAccess,
  resendPortalAccess,
  revokePortalGrant,
  upsertPortalPolicy,
} from "@odentia/services"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { portalOrigin } from "../lib/portal-origin.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"
import { portalAccessInput, portalIdInput, portalPolicyInput } from "./portal-input.js"

/**
 * El portal del paciente desde la página de la persona (Datos › Acceso al
 * portal) y su configuración. Un solo paso (decisión 9, ADR 0037): «Dar
 * acceso», «Enviar nuevo enlace» y «Quitar acceso».
 * - Dar el acceso (comprobar su identidad), mostrar el QR, decir el código y
 *   quitarlo es de quien puede ver la historia (`clinical.read`: la dueña, el
 *   administrador, el odontólogo o el médico; ADR 0156): el portal entrega toda
 *   su historia documental. Recepción (`patients.write`) solo envía el enlace de
 *   un acceso ya dado por su WhatsApp, con el código en otro mensaje a la
 *   persona: nunca le llegan a su pantalla.
 * - Lo que verá no lo elige quien da el acceso (ADR 0156): todo lo suyo, con el
 *   límite de la clínica en Configuración.
 * - El token crudo solo viaja en el QR (una vez) o en el mensaje a la persona;
 *   el código de 6 dígitos vuelve a quien da el acceso, para decírselo aparte.
 */
export function createPortalRoute(deps: Pick<CrmDeps, "db"> & { webURL: string }) {
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
    "clinical.read": "El acceso al portal lo da quien puede ver la historia: el portal muestra sus documentos",
  }

  function deny(c: Context, permission: string) {
    return c.json(
      errorBody(c, "FORBIDDEN", DENIED[permission] ?? "No tienes permiso para hacer esto en el portal"),
      403,
    )
  }

  async function linkUrl(orgId: string): Promise<((token: string) => string) | null> {
    // Con la clínica en contexto: su producto vive en su perfil (con RLS).
    const clinic = await withOrgContext(deps.db, orgId, (tx) => clinicAddressOf(tx, orgId))
    if (!clinic) return null
    const base = portalOrigin(deps, clinic)
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

  /** Quien ve la historia da el acceso; recepción solo lo envía por WhatsApp. */
  const gives = (role: string) => canAccess(role, "clinical.read")
  const sends = (role: string) => gives(role) || canAccess(role, "patients.write")

  // La fila de acceso de la persona y a quién se le puede dar.
  app.get("/access", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!sends(memberRole)) return deny(c, "clinical.read")
    const query = z.object({ patientId: z.uuid() }).safeParse(c.req.query())
    if (!query.success) return validationError(c, query.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getPortalAccessSummary(tx, orgId, query.data.patientId)),
    )
  })

  app.post("/access", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!gives(memberRole)) return deny(c, "clinical.read")
    const parsed = portalAccessInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const url = await linkUrl(orgId)
    if (!url) return c.json(errorBody(c, "NOT_FOUND", "Organización no disponible"), 404)
    const { patientId, ...input } = parsed.data
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => givePortalAccess(tx, orgId, userId, patientId, input, { linkUrl: url })),
    )
  })

  // «Enviar nuevo enlace»: para volver a entrar, sin volver a comprobar su identidad. Recepción
  // solo por su WhatsApp, con el código en otro mensaje a la persona: nada vuelve a su pantalla.
  app.post("/access/:id/resend", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!sends(memberRole)) return deny(c, "clinical.read")
    const params = portalIdInput.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = z.strictObject({ delivery: z.enum(["qr", "whatsapp"]) }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const staffSees = gives(memberRole)
    if (!staffSees && parsed.data.delivery !== "whatsapp") {
      const message = "Mostrar el QR es de quien puede ver la historia: envíaselo por su WhatsApp"
      return c.json(errorBody(c, "FORBIDDEN", message, { delivery: message }), 403)
    }
    const url = await linkUrl(orgId)
    if (!url) return c.json(errorBody(c, "NOT_FOUND", "Organización no disponible"), 404)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        resendPortalAccess(tx, orgId, userId, params.data.id, { ...parsed.data, staffSees }, { linkUrl: url }),
      ),
    )
  })

  // «Cambiar» de la pantalla anterior: ya no se elige qué verá (ADR 0156). Responde mientras
  // dura el despliegue, para que una pestaña abierta con la versión anterior lo diga; se quita después.
  app.patch("/access/:id", (c) =>
    c.json(errorBody(c, "GONE", "Ya no se elige qué verá: ve todo lo suyo. Recarga la página."), 410),
  )

  // «Quitar acceso» cierra todo: sesiones, llaves y enlaces.
  app.post("/access/:id/revoke", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!gives(memberRole)) return deny(c, "clinical.read")
    const params = portalIdInput.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => revokePortalGrant(tx, orgId, userId, params.data.id, "Quitó el acceso desde la página de la persona")),
    )
  })

  return app
}
