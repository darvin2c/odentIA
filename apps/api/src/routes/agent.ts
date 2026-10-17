import { extractDictation, isProviderConfigError, meterAiUse, type ModelChecker, type PlatformLlm } from "@odentia/agent"
import type { Db } from "@odentia/db"
import { withOrgContext } from "@odentia/db"
import {
  AGENT_BASE_PRINCIPLES,
  AGENT_LLM_IDS,
  AGENT_ROLE_IDS,
  AGENT_ROLES,
  getAgentConfig,
  getAgentOverview,
  operationFillsOf,
  previewDictationSuggestions,
  upsertAgentConfig,
  assertAgentTestBudget,
  assertAgentsNotPaused,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { checkOrgModel, modelProblemResponse, orgModelCheck } from "../lib/agent-model.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const putInput = z.object({
  enabled: z.boolean().optional(),
  /** Uno de los modelos que odentIA validó (`AGENT_LLMS`); la cuenta es de odentIA. */
  llm: z.enum(AGENT_LLM_IDS).optional(),
  dailyRunLimit: z.number().int().min(1).max(100_000).optional(),
  decisionProvider: z.enum(["none", "baseline", "jev", "openai_decisions"]).optional(),
  systemPrompt: z.string().max(8000).optional(),
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
  activeFromMin: z.number().int().min(0).max(1439).nullable().optional(),
  activeUntilMin: z.number().int().min(1).max(1440).nullable().optional(),
  channels: z.array(z.string().max(40)).max(20).nullable().optional(),
  /** Horas de silencio tras las que el agente se despide y cierra (ADR 0024). */
  closeAfterHours: z.number().int().min(6).max(23).optional(),
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
  app.get("/model", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    const fresh = c.req.query("fresh") === "1"
    return runService(c, 200, async () => {
      const { llm } = await withOrgContext(deps.db, orgId, (tx) => getAgentConfig(tx, orgId))
      return checkOrgModel(deps, orgId, llm, { fresh })
    })
  })

  /**
   * Fichas de los agentes, la base fija y los niveles: lo mismo que usa el
   * agente al ejecutarse, para que la pantalla no describa otra cosa.
   */
  app.get("/roles", async (c) => {
    const { memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    return c.json({
      data: {
        principles: AGENT_BASE_PRINCIPLES,
        // «Qué puede llenar» sale de la misma declaración que valida la ruta y la herramienta.
        roles: AGENT_ROLE_IDS.map((id) => ({
          ...AGENT_ROLES[id],
          functions: AGENT_ROLES[id].functions.map((fn) => ({ ...fn, fills: operationFillsOf(fn.tools) })),
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

  /**
   * Dictado de práctica del asistente clínico: ordena un texto en sugerencias
   * con los servicios y el catálogo reales de la clínica, sin paciente ni
   * atención. No guarda nada.
   */
  app.post("/clinical/practice", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Esto lo cambia quien administra el agente"), 403)
    const parsed = z.object({ transcript: z.string().trim().min(3).max(12_000) }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      return await runService(c, 200, async () => {
        await withOrgContext(deps.db, orgId, async (tx) => {
          await assertAgentsNotPaused(tx, orgId)
          await assertAgentTestBudget(tx, orgId)
        })
        const extracted = await meterAiUse(deps.db, orgId, "practica_dictado", () =>
          extractDictation(deps.db, { secretsKey: deps.secretsKey, platform: deps.llm }, { orgId, transcript: parsed.data.transcript }),
        )
        return {
          model: extracted.model,
          suggestions: await withOrgContext(deps.db, orgId, (tx) => previewDictationSuggestions(tx, orgId, extracted.drafts)),
        }
      })
    } catch (error) {
      if (isProviderConfigError(error)) return modelProblemResponse(c, deps, orgId, error, "asistente")
      throw error
    }
  })

  return app
}
