import { withOrgContext } from "@odentia/db"
import { deletePushSubscription, getPushSubscription, savePushSubscription, workspaceAccessFor } from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const endpointInput = z.object({ endpoint: z.string().url().max(1000) })
const subscribeInput = endpointInput.extend({ keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }) })

/**
 * Avisos en este equipo (push web, ADR 0177). Cada persona del equipo los
 * activa para sí en su equipo: no hace falta un permiso, porque lo que llega
 * se decide al enviar con los permisos que tiene en ese momento.
 */
export function createPushRoute(deps: CrmDeps & { vapidPublicKey?: string }) {
  const app = new Hono()
  // La clave pública con que el navegador se suscribe. Sin ella, los avisos no están disponibles aquí.
  app.get("/key", c => c.json({ data: { publicKey: deps.vapidPublicKey || null } }))
  app.post("/subscriptions", async c => {
    if (!deps.vapidPublicKey) return c.json(errorBody(c, "UNAVAILABLE", "Los avisos en el equipo no están disponibles"), 503)
    const { orgId, userId, memberRole } = orgContextOf(c)
    const body = subscribeInput.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return validationError(c, body.error.issues)
    const { endpoint, keys } = body.data
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      savePushSubscription(tx, orgId, userId, workspaceAccessFor(memberRole), { endpoint, ...keys })))
  })
  // ¿Este equipo recibe hoy mis avisos? Otra persona pudo activarlos después en el mismo equipo.
  app.post("/subscriptions/state", async c => {
    const { orgId, userId } = orgContextOf(c)
    const body = endpointInput.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return validationError(c, body.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => getPushSubscription(tx, orgId, userId, body.data.endpoint)))
  })
  app.delete("/subscriptions", async c => {
    const { orgId, userId } = orgContextOf(c)
    const body = endpointInput.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return validationError(c, body.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => deletePushSubscription(tx, orgId, userId, body.data.endpoint)))
  })
  return app
}
