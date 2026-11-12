import { withOrgContext } from "@odentia/db"
import { ALL_PERMISSIONS } from "@odentia/auth/permissions"
import {
  AUDIT_AREAS,
  claimHandoff,
  countWorkspaceWaiting,
  getPersonPanel,
  getWorkspaceHome,
  listMyOverdueControls,
  listOldUnclosed,
  proposeLessonFromReply,
  reopenTopic,
  replyToTopic,
  listWorkspaceAudit,
  listWorkspaceNotifications,
  recordHomeVisit,
  readAllWorkspaceNotifications,
  readWorkspaceNotification,
  workspaceAccessFor,
} from "@odentia/services"
import { Hono } from "hono"
import { isSupportRequest } from "../lib/support-session.js"
import { z } from "zod"
import { canAccess, canAccessAny, orgContextOf, type Permission } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const accessFor = workspaceAccessFor
/**
 * Cada aviso declara el permiso que necesita quien lo lee y llega a quien lo
 * tiene: se pasan todos los permisos del rol (también `settings.write`,
 * `agent.write` o `commissions.read`), no solo los de lectura.
 */
const noticePermissions = (role: string) => ALL_PERMISSIONS.filter(permission => canAccess(role, permission))
const homeInput = z.object({ branch: z.string().uuid().optional() })
const auditInput = z.object({ action: z.string().max(120).optional(), area: z.enum(AUDIT_AREAS).optional(), before: z.string().datetime({ offset: true }).optional(), beforeId: z.string().uuid().optional(), beforePerson: z.union([z.literal(""), z.string().uuid()]).optional() })

export function createWorkspaceRoute(deps: CrmDeps) {
  const app = new Hono()
  app.get("/home", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const parsed = homeInput.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const can = (permission: string) => canAccess(memberRole, permission as Permission)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      getWorkspaceHome(tx, orgId, userId, accessFor(memberRole), { branchId: parsed.data.branch, can })))
  })
  // Los controles vencidos que indicó quien mira (su Inicio de profesional).
  app.get("/my-overdue-controls", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo quien atiende tiene controles propios"), 403)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, async tx => ({ items: await listMyOverdueControls(tx, orgId, userId) })))
  })
  // Las citas sin cerrar de hace más de un mes, para cerrarlas de una vez desde Inicio.
  app.get("/unclosed-old", c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, async tx =>
      ({ items: await listOldUnclosed(tx, orgId, userId, accessFor(memberRole)) })))
  })
  // El número de «Inicio» en el menú: cuántas personas esperan a quien mira.
  app.get("/waiting", c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, async tx =>
      ({ people: await countWorkspaceWaiting(tx, orgId, userId, accessFor(memberRole)) })))
  })
  // «Mientras no estabas»: Inicio avisa que la persona la está mirando; la primera vez del día responde lo que hicieron los agentes.
  app.post("/visit", c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, async tx =>
      ({ away: await recordHomeVisit(tx, orgId, userId, accessFor(memberRole)) })))
  })
  app.get("/notifications", c => {
    // Soporte mirando la clínica no es del equipo: no tiene avisos propios (y leerlos
    // ordena la lista escribiendo, lo que su sesión de solo lectura no puede).
    if (isSupportRequest(c)) return c.json({ data: { items: [], unread: 0 } })
    const { orgId, userId, memberRole } = orgContextOf(c)
    const permissions = noticePermissions(memberRole)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => listWorkspaceNotifications(tx, orgId, userId, permissions)))
  })
  // «Marcar todo leído»: antes de la ruta con `:id` para que no la tome como uno.
  app.post("/notifications/read-all", c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const permissions = noticePermissions(memberRole)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => readAllWorkspaceNotifications(tx, orgId, userId, permissions)))
  })
  app.post("/notifications/:id/read", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const parsed = z.string().uuid().safeParse(c.req.param("id"))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const permissions = noticePermissions(memberRole)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => readWorkspaceNotification(tx, orgId, userId, parsed.data, permissions)))
  })
  // Temas que llegan a «Te espera» (R3 y decisión 3 del pulido de la Bandeja):
  // «Tomar este tema» y «Responder» sin entrar a la Bandeja. Lo pide quien
  // escribe en conversaciones o quien responde sus temas (caja, los pagos);
  // `claimHandoff` decide si esa persona puede tenerlo.
  app.post("/topics/:id/take", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["conversations.write", "conversations.topics"])) return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para atender temas"), 403)
    const parsed = z.string().uuid().safeParse(c.req.param("id"))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => claimHandoff(tx, orgId, userId, parsed.data, { takeOver: true })))
  })
  // El panel de una persona (ADR 0127): cada parte, solo si el rol la lee; caja, solo su pago.
  app.get("/person-panel", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["conversations.read", "conversations.topics"])) return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para abrir esta conversación"), 403)
    const parsed = z.object({ conversationId: z.string().uuid(), topicId: z.string().uuid().optional(), fromRecord: z.literal("1").optional() }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { fromRecord, ...query } = parsed.data
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, tx =>
        getPersonPanel(tx, orgId, { ...query, fromRecord: fromRecord === "1", userId, can: permission => canAccess(memberRole, permission as Permission) }),
      ),
    )
  })
  // «Dejar pendiente» después de responder (ADR 0122), también para caja.
  app.post("/topics/:id/reopen", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["conversations.write", "conversations.topics"])) return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para responder temas"), 403)
    const id = z.string().uuid().safeParse(c.req.param("id"))
    const body = z.object({ conversationId: z.string().uuid() }).strict().safeParse(await c.req.json().catch(() => null))
    if (!id.success) return validationError(c, id.error.issues)
    if (!body.success) return validationError(c, body.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async tx => {
        await reopenTopic(tx, orgId, { conversationId: body.data.conversationId, topicId: id.data, userId })
        return { ok: true }
      }),
    )
  })
  // «Enseñárselo a Sofi»: queda por aprobar en Aprender. Lo aprueba quien administra el agente.
  app.post("/teach", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "conversations.write")) return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para enseñarle al agente"), 403)
    const body = z.object({ conversationId: z.string().uuid(), question: z.string().trim().min(1).max(2000), answer: z.string().trim().min(1).max(2000) }).strict().safeParse(await c.req.json().catch(() => null))
    if (!body.success) return validationError(c, body.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, tx => proposeLessonFromReply(tx, orgId, userId, body.data)))
  })
  app.post("/topics/:id/reply", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["conversations.write", "conversations.topics"])) return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para atender temas"), 403)
    const id = z.string().uuid().safeParse(c.req.param("id"))
    const body = z.object({ text: z.string().trim().min(1).max(4000), takeOver: z.boolean().optional() }).strict().safeParse(await c.req.json().catch(() => null))
    if (!id.success) return validationError(c, id.error.issues)
    if (!body.success) return validationError(c, body.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, tx => replyToTopic(tx, orgId, { topicId: id.data, userId, text: body.data.text, takeOver: body.data.takeOver === true && canAccess(memberRole, "conversations.write") })))
  })
  app.get("/audit", async c => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "audit.read")) return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para consultar la actividad del equipo"), 403)
    const parsed = auditInput.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => listWorkspaceAudit(tx, orgId, parsed.data)))
  })
  return app
}
