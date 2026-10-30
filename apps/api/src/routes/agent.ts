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

/** Mensajes con las mismas palabras que los cajones de la base y de los límites. */
const HOURS_RANGE = "Escribe un número de horas entre 6 y 23."

const putInput = z.object({
  enabled: z.boolean().optional(),
  decisionProvider: z.enum(["none", "baseline", "jev"]).optional(),
  handoffKeywords: z
    .array(z.string().max(60, "Cada palabra clave puede tener como mucho 60 caracteres."))
    .max(30, "Escribe como mucho 30 palabras clave.")
    .optional(),
  maxTurns: z.number().int().min(1).max(50).optional(),
  replyCheckEnabled: z.boolean().optional(),
  decisionRoutingEnabled: z.boolean().optional(),
  clinicalAssistantEnabled: z.boolean().optional(),
  personaName: z.string().max(40, "El nombre puede tener como mucho 40 caracteres.").nullable().optional(),
  treatment: z.enum(["tu", "usted"]).nullable().optional(),
  tone: z.enum(["cercano", "neutro", "formal"]).optional(),
  emojis: z.enum(["no", "pocos"]).optional(),
  about: z.string().max(600, "Escribe como mucho 600 caracteres.").optional(),
  disabledFunctions: z.array(z.string().max(40)).max(20).optional(),
  functionNotes: z.record(z.string().max(40), z.string().max(300, "Escribe como mucho 300 caracteres.")).optional(),
  /** Horas de silencio tras las que el agente se despide y cierra (ADR 0024). */
  closeAfterHours: z.number({ error: HOURS_RANGE }).int(HOURS_RANGE).min(6, HOURS_RANGE).max(23, HOURS_RANGE).optional(),
})

/**
 * Por día (0 = domingo), sus tramos en minutos locales. La ruta solo exige los
 * siete días: el tope por día, cada tramo y los cruces los valida el servicio,
 * que señala el día (`week[d]`) o el tramo (`week[d][i]`) con su mensaje.
 */
const writingHoursInput = z.object({
  week: z
    .array(z.array(z.unknown(), "Cada día del horario es una lista de tramos."), "El horario de recontacto va por los siete días de la semana.")
    .length(7, "El horario de recontacto va por los siete días de la semana."),
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
    const texts = await withOrgContext(deps.db, orgId, (tx) => productAgentTexts(tx, orgId))
    const roles = agentRolesFor(texts)
    return c.json({
      data: {
        principles: AGENT_BASE_PRINCIPLES,
        // «Qué puede llenar» sale de la misma declaración que valida la ruta y la herramienta.
        roles: AGENT_ROLE_IDS.map((id) => ({
          ...roles[id],
          functions: roles[id].functions.map((fn) => ({ ...fn, fills: operationFillsOf(fn.tools, { room: texts.room, clinician: texts.clinician }) })),
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
