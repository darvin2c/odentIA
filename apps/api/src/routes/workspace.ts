import { withOrgContext } from "@odentia/db"
import { ALL_PERMISSIONS } from "@odentia/auth/permissions"
import {
  AUDIT_AREAS,
  getWorkspaceHome,
  listWorkspaceAudit,
  listWorkspaceNotifications,
  readAllWorkspaceNotifications,
  readWorkspaceNotification,
  taskAreasOfRole,
  type WorkspaceAccess,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, canAccessAny, orgContextOf, type Permission } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

function accessFor(role: string): WorkspaceAccess {
  return {
    patients: canAccess(role, "patients.read"), appointments: canAccess(role, "appointments.read"),
    conversations: canAccess(role, "conversations.read"), tasks: canAccess(role, "tasks.read"),
    finance: canAccess(role, "finance.read"), clinical: canAccess(role, "clinical.read"),
    // Lo que el agente dejó en manos del equipo lo ve quien supervisa o quien
    // decide; la configuración y el proveedor siguen en `agent.write`.
    crm: canAccess(role, "crm.read"), agent: canAccessAny(role, ["agent.read", "agent.decide"]),
    allTasks: canAccess(role, "tasks.all"),
    // Las tareas sin responsable de un área llegan a quien trabaja en ella (la misma regla que Tareas).
    taskAreas: taskAreasOfRole(role),
    configure: canAccess(role, "settings.write"),
    // El odontólogo ve solo su propio día, no la agenda de la sede.
    ownAppointments: role === "dentist",
    // Quien escribe en la historia y hoy tiene citas propias ve «Mis pacientes de
    // hoy», también la dueña; el servicio mira si las tiene (ADR 0032).
    attends: canAccess(role, "clinical.write"),
  }
}
/**
 * Cada aviso declara el permiso que necesita quien lo lee y llega a quien lo
 * tiene: se pasan todos los permisos del rol (también `settings.write`,
 * `agent.write` o `commissions.read`), no solo los de lectura.
 */
const noticePermissions = (role: string) => ALL_PERMISSIONS.filter(permission => canAccess(role, permission))
const homeInput = z.object({ branch: z.string().uuid().optional() })
const auditInput = z.object({ action: z.string().max(120).optional(), area: z.enum(AUDIT_AREAS).optional(), before: z.string().datetime({ offset: true }).optional(), beforeId: z.string().uuid().optional() })

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
  app.get("/notifications", c => {
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
  app.get("/audit", async c => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "audit.read")) return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para consultar la actividad del equipo"), 403)
    const parsed = auditInput.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => listWorkspaceAudit(tx, orgId, parsed.data)))
  })
  return app
}
