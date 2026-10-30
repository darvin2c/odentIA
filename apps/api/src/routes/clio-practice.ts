import { extractDictation, isProviderConfigError, meterAiUse } from "@odentia/agent"
import { withOrgContext } from "@odentia/db"
import { assertAgentsNotPaused, assertAgentTestBudget, previewDictationSuggestions, requireDictatingProduct } from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { modelProblemResponse } from "../lib/agent-model.js"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import type { AgentRouteDeps } from "./agent.js"
import { runService, validationError } from "./helpers.js"

/** Mismas palabras que el campo de la pantalla de práctica. */
const practiceInput = z.object({
  transcript: z
    .string()
    .trim()
    .min(3, "Escribe al menos 3 caracteres.")
    .max(12_000, "Escribe como mucho 12000 caracteres."),
})

/** Clío en la configuración del agente: practicar el dictado con el producto de la clínica (ADR 0079). */
export function createClioPracticeRoute(deps: AgentRouteDeps) {
  const app = new Hono()

  /**
   * Dictado de práctica del asistente clínico: ordena un texto en sugerencias
   * con los servicios y el catálogo reales de la clínica, sin paciente ni
   * atención. No guarda nada.
   */
  app.post("/clinical/practice", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Esto lo cambia quien administra el agente"), 403)
    const parsed = practiceInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      return await runService(c, 200, async () => {
        await withOrgContext(deps.db, orgId, async (tx) => {
          await assertAgentsNotPaused(tx, orgId)
          await assertAgentTestBudget(tx, orgId)
          await requireDictatingProduct(tx, orgId)
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
