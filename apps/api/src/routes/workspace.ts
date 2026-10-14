import { withOrgContext } from "@odentia/db"
import { AUDIT_AREAS, getWorkspaceHome, listWorkspaceAudit, listWorkspaceNotifications, readWorkspaceNotification, type WorkspaceAccess } from "@odentia/services"
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
    allTasks: role === "owner" || role === "admin",
    // Las tareas que el Administrador deja a un área llegan a quien trabaja en ella.
    taskAreas: role === "reception" ? ["recepcion"] : role === "cashier" ? ["caja"] : role === "dentist" ? ["clinico"] : [],
    configure: canAccess(role, "settings.write"),
    // Quien atiende ve su propio día, no la agenda de la sede.
    ownAppointments: role === "dentist",
  }
}
const domains = ["patients", "clinical", "appointments", "crm", "conversations", "tasks", "finance", "inventory", "reports", "settings", "audit", "agent"]
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
    // Los avisos de aprobación usan `agent.decide` (ver ProposalLifecycle):
    // recepción operativa los recibe sin lectura general del agente.
    const permissions = [
      ...domains.map(domain => `${domain}.read`).filter(permission => canAccess(memberRole, permission)),
      ...(canAccess(memberRole, "agent.decide") ? ["agent.decide"] : []),
    ]
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => listWorkspaceNotifications(tx, orgId, userId, permissions)))
  })
  app.post("/notifications/:id/read", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const parsed = z.string().uuid().safeParse(c.req.param("id"))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const permissions = [
      ...domains.map(domain => `${domain}.read`).filter(permission => canAccess(memberRole, permission)),
      ...(canAccess(memberRole, "agent.decide") ? ["agent.decide"] : []),
    ]
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
