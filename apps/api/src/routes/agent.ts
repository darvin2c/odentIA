import { assertSafeBaseUrl, LlmConfigError, type PlatformLlm, resolveLlmSpec, testLlmConnection } from "@odentia/agent"
import { withOrgContext } from "@odentia/db"
import { getAgentConfig, getAgentLlmSecrets, ServiceError, upsertAgentConfig, validateLlmBaseUrl } from "@odentia/services"
import { getAutonomyPolicy, updateAutonomyPolicy } from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const putInput = z.object({
  enabled: z.boolean().optional(),
  model: z.string().max(120).nullable().optional(),
  llmBaseUrl: z.string().max(300).nullable().optional(),
  /** Solo se envía para cambiarla; null la borra. Nunca se devuelve. */
  llmApiKey: z.string().max(500).nullable().optional(),
  dailyRunLimit: z.number().int().min(1).max(100_000).optional(),
  decisionProvider: z.enum(["none", "baseline", "jev", "openai_decisions"]).optional(),
  systemPrompt: z.string().max(8000).optional(),
  handoffKeywords: z.array(z.string().max(60)).max(30).optional(),
  maxTurns: z.number().int().min(1).max(50).optional(),
})

const testInput = z.object({
  model: z.string().max(120).nullable().optional(),
  llmBaseUrl: z.string().max(300).nullable().optional(),
  /** Ausente: se prueba con la clave guardada, si la hay. */
  llmApiKey: z.string().max(500).nullable().optional(),
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

export interface AgentRouteDeps extends CrmDeps {
  llm: PlatformLlm
}

export function createAgentRoute(deps: AgentRouteDeps) {
  const app = new Hono()
  const allowInsecure = deps.llm.allowInsecureBaseUrl === true

  app.get("/config", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getAgentConfig(tx, orgId)),
    )
  })

  app.put("/config", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = putInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    // La URL se resuelve por DNS antes de guardarla: una organización no puede
    // apuntar el agente a la red interna aunque el nombre parezca público.
    if (parsed.data.llmBaseUrl) {
      try {
        await assertSafeBaseUrl(parsed.data.llmBaseUrl, { allowInsecure })
      } catch (error) {
        if (error instanceof LlmConfigError) return c.json(errorBody(c, "VALIDATION", error.message), 400)
        throw error
      }
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        upsertAgentConfig(tx, orgId, parsed.data, {
          secretsKey: deps.secretsKey,
          actorUserId: userId,
          allowInsecureBaseUrl: allowInsecure,
        }),
      ),
    )
  })

  /**
   * Prueba de conexión con los valores del formulario (o los guardados): una
   * petición mínima al proveedor. No escribe nada ni acredita calidad.
   */
  app.post("/config/llm/test", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = testInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const body = parsed.data
    try {
      // Lecturas dentro de la transacción; la red (DNS y la petición) fuera.
      const { cfg, stored } = await withOrgContext(deps.db, orgId, async (tx) => {
        const cfg = await getAgentConfig(tx, orgId)
        const stored = cfg.hasLlmApiKey ? await getAgentLlmSecrets(tx, orgId, deps.secretsKey) : null
        return { cfg, stored }
      })
      const baseUrl =
        body.llmBaseUrl === undefined
          ? cfg.llmBaseUrl
          : body.llmBaseUrl?.trim()
            ? validateLlmBaseUrl(body.llmBaseUrl, { allowInsecure })
            : null
      // La clave guardada solo se reutiliza con su misma URL: nunca viaja a un host nuevo.
      const apiKey = body.llmApiKey?.trim() || (baseUrl && stored && baseUrl === stored.baseUrl ? stored.apiKey : null)
      if ((baseUrl === null) !== (apiKey === null)) {
        throw new LlmConfigError(
          baseUrl === null ? "BASE_URL_INVALID" : "API_KEY_REQUIRED",
          baseUrl === null ? "Indica la URL base del proveedor" : "Indica la clave de API del proveedor",
        )
      }
      if (baseUrl) await assertSafeBaseUrl(baseUrl, { allowInsecure })
      const model = body.model === undefined ? cfg.model : body.model
      const spec = resolveLlmSpec({ model }, baseUrl && apiKey ? { baseUrl, apiKey } : null, deps.llm)
      return c.json({ data: await testLlmConnection(spec) })
    } catch (error) {
      if (error instanceof LlmConfigError || error instanceof ServiceError) {
        return c.json({ data: { ok: false, latencyMs: 0, model: null, error: error.message } })
      }
      throw error
    }
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
