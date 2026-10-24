import { isProviderConfigError, meterAiUse, type PlatformLlm } from "@odentia/agent"
import { extractDictation } from "@odentia/agent/dental"
import { type Db, withOrgContext } from "@odentia/db"
import {
  assertClioCanListen,
  getAgentConfig,
} from "@odentia/services"
import {
  confirmDictationSuggestion,
  countConfirmedDictation,
  dictationModelLabel,
  dictationSegmentSeen,
  discardDictationSuggestion,
  discardPendingDictation,
  issueDictationPrescription,
  listDictationSuggestions,
  listVoiceRemovedDictation,
  requireClinicalAssistant,
  saveDictationSegment,
  settleDictationPrescription,
  undoDictationVoiceCorrection,
  updateDictationSuggestion,
} from "@odentia/services/dental"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../../lib/context.js"
import { modelProblemResponse } from "../../lib/agent-model.js"
import { errorBody } from "../../lib/error.js"
import { type CrmDeps, runService, validationError } from "../helpers.js"

const params = z.object({ id: z.uuid(), encounterId: z.uuid() })
const suggestionParams = params.extend({ suggestionId: z.uuid() })
// Un tramo del dictado: lo nuevo, lo último ya ordenado (solo para entenderlo) y su identidad,
// para que reenviar el mismo tramo no duplique sugerencias.
const dictateInput = z
  .object({
    transcript: z.string().trim().min(3).max(12_000),
    context: z.string().max(2_000).optional(),
    segmentId: z.uuid().optional(),
  })
  .strict()
// Lo que el odontólogo puede corregir de una sugerencia; el servicio vuelve a validarla contra su operación.
const patchInput = z.record(z.string().max(40), z.union([z.string().max(10_000), z.number(), z.array(z.string().max(20)).max(5), z.null()]))

export interface EncounterDictationDeps extends CrmDeps {
  llm: PlatformLlm
  /** Rol owner: el caso «Modelo sin responder» en Soporte de odentIA. */
  ownerDb?: Db
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
        // Las quitadas por voz, que se pueden devolver hasta firmar.
        removedByVoice: await listVoiceRemovedDictation(tx, orgId, at.data.id, at.data.encounterId),
        // Para decir, antes de firmar, cuántas ya entraron a la atención.
        confirmed: await countConfirmedDictation(tx, orgId, at.data.id, at.data.encounterId),
      })),
    )
  })

  /**
   * Ordena un tramo del dictado en sugerencias. Llama al modelo una vez; nada
   * entra a la historia. Mientras se dicta llega un tramo por pausa: el modelo
   * recibe además las sugerencias de este dictado que siguen sin decidir, para
   * entender una corrección dicha en voz alta.
   */
  app.post(base, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = params.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    const parsed = dictateInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { transcript, context, segmentId } = parsed.data
    try {
      return await runService(c, 201, async () => {
        // Antes de gastar una llamada al modelo: encendido, atención propia en borrador y tramo nuevo.
        const before = await withOrgContext(deps.db, orgId, async (tx) => {
          await requireClinicalAssistant(tx, orgId)
          await saveDictationSegment(tx, orgId, userId, at.data.id, at.data.encounterId, { drafts: [] })
          if (segmentId && (await dictationSegmentSeen(tx, orgId, at.data.id, at.data.encounterId, segmentId))) return null
          return listDictationSuggestions(tx, orgId, at.data.id, at.data.encounterId)
        })
        if (!before) return { suggestions: [], corrected: [], removed: [], sources: [], omitted: 0, unused: [], repeated: true, model: null }
        // Sin saldo de prueba los agentes están en pausa (ADR 0031); con el presupuesto del mes
        // alcanzado, Clío no empieza a escuchar en esta atención (ADR 0085): no se gasta una llamada.
        await withOrgContext(deps.db, orgId, (tx) => assertClioCanListen(tx, orgId, at.data.encounterId))
        const extracted = await meterAiUse(deps.db, orgId, "dictado", () =>
          extractDictation(
            deps.db,
            { secretsKey: deps.secretsKey, platform: deps.llm },
            { orgId, transcript, context, pending: before.map((item) => ({ label: dictationModelLabel(item) })) },
          ),
          { encounterId: at.data.encounterId },
        )
        // El número que usó el modelo es la posición en la lista que se le dio.
        const target = (index: number) => before[index]?.id
        const saved = await withOrgContext(deps.db, orgId, (tx) =>
          saveDictationSegment(tx, orgId, userId, at.data.id, at.data.encounterId, {
            drafts: extracted.drafts,
            corrections: extracted.corrections.flatMap((item) => {
              const suggestionId = target(item.index)
              return suggestionId ? [{ suggestionId, changes: item.changes }] : []
            }),
            removals: extracted.removals.flatMap((item) => {
              const suggestionId = target(item.index)
              return suggestionId ? [{ suggestionId, said: item.sourceText }] : []
            }),
            segmentId,
          }),
        )
        // Los fragmentos de este tramo que dieron lugar a algo: la pantalla los resalta en su respaldo.
        const sources = [...extracted.drafts, ...extracted.corrections, ...extracted.removals].map((item) => item.sourceText ?? "").filter(Boolean)
        // Lo que el asistente no pudo usar de este tramo, con la frase si se sabe, para avisarle al odontólogo en vez de perderlo en silencio.
        return { ...saved, sources, omitted: extracted.omitted, unused: extracted.unused, model: extracted.model }
      })
    } catch (error) {
      if (isProviderConfigError(error)) return modelProblemResponse(c, deps, orgId, error, "asistente")
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

  /** Deshace lo hecho en voz alta, una corrección o un «quita»: la sugerencia vuelve a como estaba. */
  app.post(`${base}/:suggestionId/undo-voice`, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = suggestionParams.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        undoDictationVoiceCorrection(tx, orgId, userId, at.data.id, at.data.encounterId, at.data.suggestionId),
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

  /** «Emitir receta» de la receta dictada: una receta con todos sus medicamentos (issue 109, fase 2). */
  app.post(`${base}/prescription`, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = params.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => issueDictationPrescription(tx, orgId, userId, at.data.id, at.data.encounterId)),
    )
  })

  /** La receta dictada se terminó en el formulario de siempre: sus sugerencias quedan con esa receta. */
  app.post(`${base}/prescription/settle`, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = params.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    const parsed = z.object({ prescriptionId: z.uuid() }).strict().safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => settleDictationPrescription(tx, orgId, userId, at.data.id, at.data.encounterId, parsed.data.prescriptionId)),
    )
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
