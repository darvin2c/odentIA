import type { ModelChecker, PlatformLlm } from "@odentia/agent"
import type { Db } from "@odentia/db"
import { withOrgContext } from "@odentia/db"
import {
  AGENT_BASE_PRINCIPLES,
  AGENT_ROLE_IDS,
  agentRolesFor,
  getAgentConfig,
  getAgentOverview,
  getWritingHours,
  setWritingHours,
  operationFillsOf,
  productAgentTexts,
  upsertAgentConfig,
} from "@odentia/services"
import { createClioPracticeRoute } from "./clio-practice.js"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { checkOrgModel, orgModelCheck } from "../lib/agent-model.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const putInput = z.object({
  enabled: z.boolean().optional(),
  decisionProvider: z.enum(["none", "baseline", "jev"]).optional(),
  handoffKeywords: z.array(z.string().max(60)).max(30).optional(),
  maxTurns: z.number().int().min(1).max(50).optional(),
  replyCheckEnabled: z.boolean().optional(),
  decisionRoutingEnabled: z.boolean().optional(),
  clinicalAssistantEnabled: z.boolean().optional(),
  personaName: z.string().max(40).nullable().optional(),
  treatment: z.enum(["tu", "usted"]).nullable().optional(),
  tone: z.enum(["cercano", "neutro", "formal"]).optional(),
  emojis: z.enum(["no", "pocos"]).optional(),
  about: z.string().max(600).optional(),
  disabledFunctions: z.array(z.string().max(40)).max(20).optional(),
  functionNotes: z.record(z.string().max(40), z.string().max(300)).optional(),
  /** Horas de silencio tras las que el agente se despide y cierra (ADR 0024). */
  closeAfterHours: z.number().int().min(6).max(23).optional(),
})

/** Por día (0 = domingo), sus tramos en minutos locales; la forma y los cruces los valida el servicio. */
const writingHoursInput = z.object({
  week: z
    .array(z.array(z.tuple([z.number().int().min(0).max(1440), z.number().int().min(0).max(1440)])).max(4))
    .length(7),
})

export interface AgentRouteDeps extends CrmDeps {
  llm: PlatformLlm
  /** Rol owner: el caso «Modelo sin responder» en Soporte de odentIA. */
  ownerDb?: Db
  /** Sustituye la comprobación «El modelo responde» (pruebas). */
  modelChecker?: ModelChecker
}

export function createAgentRoute(deps: AgentRouteDeps) {
  const app = new Hono()

  app.get("/config", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getAgentConfig(tx, orgId)),
    )
  })

  app.put("/config", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Esto lo cambia quien administra el agente"), 403)
    const parsed = putInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    // Encender exige un modelo que responda, aunque se llame sin el botón.
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        upsertAgentConfig(tx, orgId, parsed.data, { actorUserId: userId, modelCheck: orgModelCheck(deps, orgId) }),
      ),
    )
  })

  /**
   * «El modelo responde»: una llamada mínima al modelo elegido (y al otro si
   * no responde), guardada 10 minutos. `fresh=1` vuelve a comprobar. Nunca
   * entrega el motivo técnico: ese va a Soporte de odentIA.
   */
  /**
   * «Horario de recontacto» (decisión 18 v3): cuándo odentIA escribe por su
   * cuenta. Lo ve quien supervisa el agente y lo cambia quien lo administra.
   */
  app.get("/writing-hours", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, async (tx) => ({ week: await getWritingHours(tx, orgId) })))
  })

  app.put("/writing-hours", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Esto lo cambia quien administra el agente"), 403)
    const parsed = writingHoursInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => ({ week: await setWritingHours(tx, orgId, userId, parsed.data.week) })),
    )
  })

  app.get("/model", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    const fresh = c.req.query("fresh") === "1"
    return runService(c, 200, () => checkOrgModel(deps, orgId, { fresh }))
  })

  /**
   * Fichas de los agentes, la base fija y los niveles: lo mismo que usa el
   * agente al ejecutarse, para que la pantalla no describa otra cosa.
   */
  app.get("/roles", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    // Con las palabras del producto de la clínica: su nombre, sus meses y su profesional (issue 229).
    const roles = await withOrgContext(deps.db, orgId, async (tx) => agentRolesFor(await productAgentTexts(tx, orgId)))
    return c.json({
      data: {
        principles: AGENT_BASE_PRINCIPLES,
        // «Qué puede llenar» sale de la misma declaración que valida la ruta y la herramienta.
        roles: AGENT_ROLE_IDS.map((id) => ({
          ...roles[id],
          functions: roles[id].functions.map((fn) => ({ ...fn, fills: operationFillsOf(fn.tools) })),
        })),
      },
    })
  })

  app.get("/overview", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getAgentOverview(tx, orgId, { modelCheck: orgModelCheck(deps, orgId) })),
    )
  })

  // La práctica del dictado de Clío, con el producto de la clínica.
  app.route("/", createClioPracticeRoute(deps))

  return app
}
