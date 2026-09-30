import { withOrgContext } from "@odentia/db"
import { getManagementReport, getWorkspaceHome, getWorkspacePulse, listWorkspaceAudit, listWorkspaceNotifications, readWorkspaceNotification, type WorkspaceAccess } from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, canAccessAny, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

function accessFor(role: string): WorkspaceAccess {
  return {
    patients: canAccess(role, "patients.read"), appointments: canAccess(role, "appointments.read"),
    conversations: canAccess(role, "conversations.read"), tasks: canAccess(role, "tasks.read"),
    finance: canAccess(role, "finance.read"), clinical: canAccess(role, "clinical.read"),
    // La banda operativa del agente (pendientes y pulso) la ve quien supervisa
    // o quien decide; la configuración y el proveedor siguen en `agent.write`.
    crm: canAccess(role, "crm.read"), agent: canAccessAny(role, ["agent.read", "agent.decide"]),
    allTasks: role === "owner" || role === "admin",
  }
}
const domains = ["patients", "clinical", "appointments", "crm", "conversations", "tasks", "finance", "inventory", "reports", "settings", "audit", "agent"]
const reportInput = z.object({ from: z.string().date(), to: z.string().date() })
const auditInput = z.object({ action: z.string().max(120).optional(), before: z.string().datetime({ offset: true }).optional(), beforeId: z.string().uuid().optional() })

export function createWorkspaceRoute(deps: CrmDeps) {
  const app = new Hono()
  app.get("/home", c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => getWorkspaceHome(tx, orgId, userId, accessFor(memberRole))))
  })
  app.get("/pulse", c => {
    const { orgId, memberRole } = orgContextOf(c)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => getWorkspacePulse(tx, orgId, accessFor(memberRole))))
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
  app.get("/reports", async c => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "reports.read")) return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para consultar reportes"), 403)
    const parsed = reportInput.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => getManagementReport(tx, orgId, parsed.data.from, parsed.data.to, accessFor(memberRole))))
  })
  app.get("/audit", async c => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "audit.read")) return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para consultar la auditoría"), 403)
    const parsed = auditInput.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => listWorkspaceAudit(tx, orgId, parsed.data)))
  })
  return app
}
