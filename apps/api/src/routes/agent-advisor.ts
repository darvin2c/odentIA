import { withOrgContext } from "@odentia/db"
import {
  createAdvisorTasks,
  getAdvisorRecommendation,
  getAdvisorRecommendations,
  getAdvisorSettings,
  updateAdvisorSettings,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf, type Permission } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const settingsInput = z.object({
  enabled: z.boolean().optional(),
  detections: z
    .record(
      z.string().max(40),
      z.object({
        on: z.boolean().optional(),
        days: z.number().int().min(1).max(365).nullable().optional(),
        snoozeDays: z.number().int().min(1).max(90).nullable().optional(),
      }),
    )
    .optional(),
})

/**
 * Asesor: recomendaciones calculadas con consultas a la base, filtradas por
 * los permisos de quien las lee. Leerlas no pide permiso del agente: cada
 * detección exige el de su dominio. Encenderlo, apagar una detección o
 * cambiar su umbral es administrar el agente.
 */
export function createAgentAdvisorRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const can = (permission: string) => canAccess(memberRole, permission as Permission)
    const all = c.req.query("all") === "1"
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getAdvisorRecommendations(tx, orgId, can, { all })))
  })

  app.get("/settings", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getAdvisorSettings(tx, orgId)))
  })

  app.put("/settings", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = settingsInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => updateAdvisorSettings(tx, orgId, userId, parsed.data)))
  })

  /** Lo que recomendaría hoy, aunque esté apagado: para decidir si se enciende. */
  app.get("/preview", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const can = (permission: string) => canAccess(memberRole, permission as Permission)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getAdvisorRecommendations(tx, orgId, can, { preview: true, all: true })),
    )
  })

  app.get("/:key", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const can = (permission: string) => canAccess(memberRole, permission as Permission)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getAdvisorRecommendation(tx, orgId, can, c.req.param("key"))))
  })

  /** La acción preparada: la pide una persona con permiso para crear tareas. */
  app.post("/:key/tasks", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "tasks.write")) return c.json(errorBody(c, "FORBIDDEN", "Sin permiso para crear tareas"), 403)
    const can = (permission: string) => canAccess(memberRole, permission as Permission)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => createAdvisorTasks(tx, orgId, userId, can, c.req.param("key"))))
  })

  return app
}
