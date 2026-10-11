import { describeProviderProblem, extractDictation, isProviderConfigError, type PlatformLlm } from "@odentia/agent"
import { withOrgContext } from "@odentia/db"
import {
  confirmDictationSuggestion,
  discardDictationSuggestion,
  discardPendingDictation,
  getAgentConfig,
  listDictationSuggestions,
  requireClinicalAssistant,
  saveDictationSuggestions,
  updateDictationSuggestion,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const params = z.object({ id: z.uuid(), encounterId: z.uuid() })
const suggestionParams = params.extend({ suggestionId: z.uuid() })
const dictateInput = z.object({ transcript: z.string().trim().min(3).max(12_000) }).strict()
// Lo que el odontólogo puede corregir de una sugerencia; el servicio vuelve a validarla contra su operación.
const patchInput = z.record(z.string().max(40), z.union([z.string().max(10_000), z.number(), z.array(z.string().max(20)).max(5), z.null()]))

export interface EncounterDictationDeps extends CrmDeps {
  llm: PlatformLlm
}

/**
 * Dictado del asistente clínico dentro de una atención. Cuelga de
 * `/patients/:id/encounters/…`, así que el permiso clínico y la traza de
 * lectura los pone el guardián de la ruta de pacientes; el servicio exige
 * además que quien dicta lleve esa atención en borrador.
 */
export function createEncounterDictationRoute(deps: EncounterDictationDeps) {
  const app = new Hono()
  const base = "/:id/encounters/:encounterId/dictation"

  app.get(base, async (c) => {
    const { orgId } = orgContextOf(c)
    const at = params.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    // La pantalla de la atención pregunta aquí si puede ofrecer el dictado: quien atiende no administra el agente.
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => ({
        enabled: (await getAgentConfig(tx, orgId)).clinicalAssistantEnabled,
        suggestions: await listDictationSuggestions(tx, orgId, at.data.id, at.data.encounterId),
      })),
    )
  })

  /** Ordena un dictado en sugerencias. Llama al modelo; nada entra a la historia. */
  app.post(base, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = params.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    const parsed = dictateInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      return await runService(c, 201, async () => {
        // Antes de gastar una llamada al modelo: encendido y atención propia en borrador.
        await withOrgContext(deps.db, orgId, async (tx) => {
          await requireClinicalAssistant(tx, orgId)
          await saveDictationSuggestions(tx, orgId, userId, at.data.id, at.data.encounterId, [])
        })
        const extracted = await extractDictation(deps.db, { secretsKey: deps.secretsKey, platform: deps.llm }, { orgId, transcript: parsed.data.transcript })
        const suggestions = await withOrgContext(deps.db, orgId, (tx) =>
          saveDictationSuggestions(tx, orgId, userId, at.data.id, at.data.encounterId, extracted.drafts),
        )
        return { suggestions, model: extracted.model }
      })
    } catch (error) {
      if (isProviderConfigError(error)) {
        const problem = describeProviderProblem(error)
        return c.json(errorBody(c, "LLM_CONFIG", `El asistente no puede usar el modelo (${problem.detail})`), 409)
      }
      throw error
    }
  })

  app.patch(`${base}/:suggestionId`, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = suggestionParams.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    const parsed = patchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateDictationSuggestion(tx, orgId, userId, at.data.id, at.data.encounterId, at.data.suggestionId, parsed.data),
      ),
    )
  })

  app.post(`${base}/:suggestionId/confirm`, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = suggestionParams.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        confirmDictationSuggestion(tx, orgId, userId, at.data.id, at.data.encounterId, at.data.suggestionId),
      ),
    )
  })

  app.post(`${base}/:suggestionId/discard`, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = suggestionParams.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    return runService(c, 200, async () => {
      await withOrgContext(deps.db, orgId, (tx) =>
        discardDictationSuggestion(tx, orgId, userId, at.data.id, at.data.encounterId, at.data.suggestionId),
      )
      return { ok: true }
    })
  })

  /** Antes de firmar: lo que no se confirmó no entra a la historia. */
  app.post(`${base}/discard-pending`, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = params.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    return runService(c, 200, async () => ({
      discarded: await withOrgContext(deps.db, orgId, (tx) => discardPendingDictation(tx, orgId, userId, at.data.id, at.data.encounterId)),
    }))
  })

  return app
}
