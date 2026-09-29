import { withOrgContext } from "@odentia/db"
import {
  createKnowledgeEntry,
  getKnowledgeEntry,
  listKnowledgeEntries,
  listKnowledgeRevisions,
  setKnowledgeStatus,
  updateKnowledgeEntry,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const createInput = z.object({
  kind: z.enum(["faq", "info_sede", "politica"]),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(8000),
  branchId: z.string().uuid().nullable().optional(),
})

const updateInput = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(8000).optional(),
  branchId: z.string().uuid().nullable().optional(),
})

const statusInput = z.object({ status: z.enum(["borrador", "publicada"]) })

export function createAgentKnowledgeRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    const query = {
      kind: c.req.query("kind"),
      status: c.req.query("status"),
      branchId: c.req.query("branchId"),
      q: c.req.query("q"),
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listKnowledgeEntries(tx, orgId, query)),
    )
  })

  app.post("/", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createKnowledgeEntry(tx, orgId, userId, parsed.data)),
    )
  })

  app.get("/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getKnowledgeEntry(tx, orgId, c.req.param("id"))),
    )
  })

  app.patch("/:id", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = updateInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => updateKnowledgeEntry(tx, orgId, userId, c.req.param("id"), parsed.data)),
    )
  })

  app.post("/:id/status", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = statusInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => setKnowledgeStatus(tx, orgId, userId, c.req.param("id"), parsed.data.status)),
    )
  })

  app.get("/:id/revisions", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listKnowledgeRevisions(tx, orgId, c.req.param("id"))),
    )
  })

  return app
}
