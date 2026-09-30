import { withOrgContext } from "@odentia/db"
import { getAgentConfig, upsertAgentConfig } from "@odentia/services"
import { getAutonomyPolicy, updateAutonomyPolicy } from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const putInput = z.object({
  enabled: z.boolean().optional(),
  model: z.string().max(120).nullable().optional(),
  systemPrompt: z.string().max(8000).optional(),
  handoffKeywords: z.array(z.string().max(60)).max(30).optional(),
  maxTurns: z.number().int().min(1).max(50).optional(),
})

const MODES = ["directo", "confirmar_usuario", "aprobar_equipo"] as const

const policyInput = z.object({
  reservar_cita: z.enum(MODES).optional(),
  reprogramar_cita: z.enum(MODES).optional(),
  cancelar_cita: z.enum(MODES).optional(),
  enviar_mensaje: z.enum(MODES).optional(),
  mover_oportunidad: z.enum(MODES).optional(),
  crear_oportunidad: z.enum(MODES).optional(),
  actualizar_seguimiento: z.enum(MODES).optional(),
  cerrar_oportunidad: z.enum(MODES).optional(),
})
export function createAgentRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/config", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getAgentConfig(tx, orgId)),
    )
  })

  app.put("/config", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = putInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => upsertAgentConfig(tx, orgId, parsed.data)),
    )
  })

  app.get("/policy", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getAutonomyPolicy(tx, orgId)),
    )
  })

  app.put("/policy", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = policyInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => updateAutonomyPolicy(tx, orgId, userId, parsed.data)),
    )
  })

  return app
}
