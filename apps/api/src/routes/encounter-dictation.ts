import { extractDictation, isProviderConfigError, meterAiUse, type PlatformLlm, reviewDictation } from "@odentia/agent"
import { type Db, withOrgContext } from "@odentia/db"
import {
  assertClioCanListen,
  clioListenBlock,
  confirmDictationHealth,
  dictatedHealthInterview,
  confirmDictationSuggestion,
  countConfirmedDictation,
  DICTATION_SPEAKERS,
  dictationFormQuestions,
  dictationModelLabel,
  dictationTeeth,
  discardDictationSuggestion,
  restoreDictationSuggestion,
  discardPendingDictation,
  getAgentConfig,
  issueDictationPrescription,
  keepConfirmedDictation,
  keepIssuedPaper,
  listConfirmedDictation,
  listDictationSaid,
  listDictationSaidSources,
  listDictationSuggestions,
  listVoiceRemovedDictation,
  pendingFormValues,
  productDictation,
  releaseDictationReview,
  releaseDictationSegment,
  saveDictationReview,
  saveDictationSegment,
  setDictationTurnSpeaker,
  settleDictationMedicalLeave,
  settleDictationRetry,
  settleDictationSegment,
  DICTATION_OUT_OF_PLACE,
  startDictationReview,
  startDictationSegment,
  settleDictationPrescription,
  undoConfirmedDictation,
  unusedOnce,
  undoDictationVoiceCorrection,
  updateDictationSuggestion,
} from "@odentia/services"
import type { DictationUnusedItem } from "@odentia/db/schema/clinical"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../lib/context.js"
import { modelProblemResponse } from "../lib/agent-model.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

/** Lo que responde una pausa que no llamó al modelo: ya ordenada, o otro pedido la está ordenando. */
const NOTHING_NEW = { suggestions: [], corrected: [], added: [], removed: [], undoRequested: [], alreadyOnFile: [], alreadyDone: [], droppedForms: [], formSources: [], sources: [], omitted: 0, unused: [], unusedWhy: {}, unusedFor: {}, model: null }

/** Si falla, quita la marca de «en curso» (sin tapar el error): se puede volver a intentar ya. */
async function releasingOnError<T>(work: () => Promise<T>, release: () => Promise<void>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    await release().catch(() => undefined)
    throw error
  }
}

const params = z.object({ id: z.uuid(), encounterId: z.uuid() })
const suggestionParams = params.extend({ suggestionId: z.uuid() })
/** Descartar: en una respuesta de ficha en la que Clío dudaba, la opción que eligió la persona. */
const discardInput = z.object({ chosen: z.string().min(1).max(200).optional() })
// Un tramo del dictado: lo nuevo y su identidad, para que reenviar el mismo tramo no lo ordene
// otra vez. Lo dicho antes ya está guardado con la atención (ADR 0209): la pantalla ya no manda
// contexto, y el de una pestaña abierta desde antes se acepta y no se usa.
const dictateInput = z
  .object({
    transcript: z.string().trim().min(3).max(12_000),
    context: z.string().max(2_000).optional(),
    segmentId: z.uuid().optional(),
    /** «Intentar otra vez» una frase de «No lo usé»: el tramo donde se dijo (no se guarda otra vez). */
    retryOf: z.string().min(1).max(100).optional(),
    /** Las fichas abiertas en pantalla: Clío las lee además de las dos últimas tocadas. */
    openForms: z.array(z.uuid()).max(5).optional(),
  })
  .strict()
// Lo que el odontólogo puede corregir de una sugerencia; el servicio vuelve a validarla contra su operación.
/** Al confirmar una respuesta de ficha: el valor que se veía. */
const confirmInput = z
  .object({
    expectedValue: z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(200)).max(40), z.null()]).optional(),
    atSign: z.boolean().optional(),
  })
  .strict()
/** «Lo revisé con…» de lo que dijo de su salud: quién lo dijo, si quien confirma lo corrige. */
const healthReviewInput = z
  .object({
    declarante: z.enum(["paciente", "acompanante", "no_se_sabe"]).optional(),
    vinculo: z.string().trim().max(80).nullable().optional(),
  })
  .strict()
/** El repaso al terminar: las fichas abiertas en pantalla, como en la pausa. */
const reviewInput = z.object({ openForms: z.array(z.uuid()).max(5).optional() }).strict()
/** Un turno de un tramo de lo que se dijo: el tramo por su identidad y el turno por su posición. */
const turnParams = params.extend({ segmentId: z.string().min(1).max(100), turn: z.coerce.number().int().min(0).max(500) })
/** «Quién habló», cambiado con un toque. */
const turnInput = z.object({ quien: z.enum(DICTATION_SPEAKERS), vinculo: z.string().trim().max(80).nullable().optional() }).strict()
const patchInput = z.record(z.string().max(40), z.union([z.string().max(10_000), z.number(), z.array(z.string().max(20)).max(5), z.null()]))

/**
 * Lo que Clío no usó de un tramo, con su motivo, para guardarlo con lo que se dijo: lo que no
 * supo dónde va (sin frase si no supo citarla), lo que quiso cambiar ya confirmado y lo que el
 * servidor no dejó pasar, con lo que se le dice a la persona. Cada frase una sola vez, con el
 * motivo del aviso si lo tiene, y sin preguntas (`unusedOnce`, QA del 22 nov, H6).
 */
function unusedOf(
  extracted: { omitted: number; unused: string[]; outOfPlace?: ReadonlyArray<{ said: string; why: keyof typeof DICTATION_OUT_OF_PLACE }> | undefined },
  onConfirmed: ReadonlyArray<{ sourceText?: string | undefined }>,
  dropped: ReadonlyArray<{ said: string; why: string; targets: Array<{ responseId: string; fieldId: string; label: string }> }>,
): DictationUnusedItem[] {
  return unusedOnce([
    ...extracted.unused.map((said): DictationUnusedItem => ({ said, why: "sin_lugar" })),
    // Lo de un familiar o un peso dicho ya en la pausa, con su motivo (QA del 21 nov): no espera al repaso.
    ...(extracted.outOfPlace ?? []).map(({ said, why }): DictationUnusedItem => {
      const detail = DICTATION_OUT_OF_PLACE[why]
      return { said, why: "sin_lugar", ...(detail ? { detail } : {}) }
    }),
    ...(extracted.omitted > extracted.unused.length ? [{ said: null, why: "sin_lugar" } satisfies DictationUnusedItem] : []),
    ...onConfirmed.flatMap((item): DictationUnusedItem[] => (item.sourceText ? [{ said: item.sourceText, why: "ya_confirmada" }] : [])),
    ...dropped.map((item): DictationUnusedItem => ({ said: item.said, why: "no_propuesta", detail: item.why, ...(item.targets.length ? { targets: item.targets } : {}) })),
  ])
}

export interface EncounterDictationDeps extends CrmDeps {
  llm: PlatformLlm
  /** Rol owner: el caso «Modelo sin responder» en Soporte de odentIA. */
  ownerDb?: Db
}

/**
 * Dictado del asistente clínico dentro de una atención, en todo producto que
 * dicte (ADR 0079: cada uno con su prompt y su formato). Cuelga de
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
    // En una clínica de un producto que no dicta, Clío no se ofrece aunque esté encendida.
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => ({
        enabled: (await getAgentConfig(tx, orgId)).clinicalAssistantEnabled && (await productDictation(tx, orgId)) !== null,
        // Lo de su salud lleva además lo de la entrevista con sus claves: «Corregir algo» lo deja puesto.
        suggestions: await Promise.all(
          (await listDictationSuggestions(tx, orgId, at.data.id, at.data.encounterId)).map(async (item) =>
            item.kind === "salud" ? { ...item, interview: await dictatedHealthInterview(tx, orgId, item.payload) } : item,
          ),
        ),
        // Las quitadas por voz, que se pueden devolver hasta firmar.
        removedByVoice: await listVoiceRemovedDictation(tx, orgId, at.data.id, at.data.encounterId),
        // Ya confirmadas que se pidió quitar en voz alta: esperan «Quitar del plan» o «Dejarla».
        undoRequests: (await listConfirmedDictation(tx, orgId, at.data.id, at.data.encounterId)).filter((item) => item.undoRequest),
        // Las piezas que ya se nombraron: a una indicación sin pieza se le ofrecen con un toque.
        teeth: await dictationTeeth(tx, orgId, at.data.id, at.data.encounterId),
        // Para decir, antes de firmar, cuántas ya entraron a la atención.
        confirmed: await countConfirmedDictation(tx, orgId, at.data.id, at.data.encounterId),
        // Con el presupuesto del mes alcanzado, Clío no escucha en una atención nueva (ADR 0085): se dice antes de dictar.
        blocked: await clioListenBlock(tx, orgId, at.data.encounterId),
      })),
    )
  })

  /**
   * Lo que se dijo en la atención, tramo por tramo, con lo que Clío no usó (ADR 0209). Lo ve
   * quien ve la atención (`clinical.read`, el guardián de la ruta de pacientes), también firmada.
   */
  app.get(`${base}/said`, async (c) => {
    const { orgId } = orgContextOf(c)
    const at = params.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => ({
        segments: await listDictationSaid(tx, orgId, at.data.id, at.data.encounterId),
        // Las frases que están en una sugerencia, pendiente o confirmada: lo resaltado sigue al recargar.
        used: await listDictationSaidSources(tx, orgId, at.data.encounterId),
      })),
    )
  })

  /**
   * Ordena un tramo del dictado en sugerencias. Lo guarda antes (lo que se dijo queda con la
   * atención) y llama al modelo una vez por tramo; nada entra a la historia. Mientras se dicta
   * llega un tramo por pausa: el modelo recibe además el final de lo dicho antes, guardado, y las
   * sugerencias de este dictado que siguen sin decidir, para entender una corrección dicha en voz alta.
   */
  app.post(base, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = params.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    const parsed = dictateInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { transcript, openForms, retryOf } = parsed.data
    // Sin identidad (una pantalla de antes), el tramo se guarda con una propia.
    const segmentId = parsed.data.segmentId ?? crypto.randomUUID()
    try {
      return await runService(c, 201, async () => {
        // Antes de gastar una llamada al modelo: encendido, atención propia en borrador y tramo
        // guardado; uno ya ordenado no se vuelve a mandar ni a cobrar, aunque no haya dejado nada.
        const ready = await withOrgContext(deps.db, orgId, async (tx) => {
          const started = await startDictationSegment(tx, orgId, userId, at.data.id, at.data.encounterId, { segmentId, transcript, retryOf })
          // Otro pedido del mismo tramo lo está ordenando: no se paga dos veces (la pantalla espera).
          if (started.repeated || started.inProgress) return started.inProgress ? "en_curso" : null
          const { dictation } = started
          // Lo dicho antes sale de lo guardado: sirve igual tras recargar o desde otra pestaña.
          const context = started.context || undefined
          // Las pendientes y, detrás, lo confirmado hoy: «quita la endodoncia» también alcanza a lo
          // que ya entró, y queda propuesto para que una persona lo decida.
          const pending = await listDictationSuggestions(tx, orgId, at.data.id, at.data.encounterId)
          const confirmed = await listConfirmedDictation(tx, orgId, at.data.id, at.data.encounterId)
          const list = [...pending, ...confirmed]
          // Las preguntas vacías de las fichas empezadas: Clío solo propone ahí (entrega 11).
          const forms = await dictationFormQuestions(tx, orgId, at.data.encounterId, { open: openForms ?? [] })
          return {
            context,
            list,
            forms,
            // Lo que ya proponen las pendientes: la segunda lectura no repite lo ya propuesto.
            formPending: pendingFormValues(pending, forms),
            pendingCount: pending.length,
            labels: [
              ...pending.map((item) => ({ label: dictationModelLabel(item, dictation) })),
              ...confirmed.map((item) => ({ label: `${dictationModelLabel(item, dictation)} · ya confirmada` })),
            ],
          }
        })
        if (ready === null) return { ...NOTHING_NEW, repeated: true }
        if (ready === "en_curso") return { ...NOTHING_NEW, repeated: true, inProgress: true }
        const extracted = await releasingOnError(
          async () => {
            // Sin saldo de prueba los agentes están en pausa (ADR 0031); con el presupuesto del mes
            // alcanzado, Clío no empieza a escuchar en esta atención (ADR 0085): no se gasta una llamada.
            await withOrgContext(deps.db, orgId, (tx) => assertClioCanListen(tx, orgId, at.data.encounterId))
            // La segunda lectura de las fichas va dentro: es la misma pausa, de la misma atención.
            return meterAiUse(
              deps.db,
              orgId,
              "dictado",
              () =>
                extractDictation(
                  deps.db,
                  { secretsKey: deps.secretsKey, platform: deps.llm },
                  { orgId, transcript, context: ready.context, pending: ready.labels, forms: ready.forms, formPending: ready.formPending },
                ),
              { encounterId: at.data.encounterId },
            )
          },
          () => withOrgContext(deps.db, orgId, (tx) => releaseDictationSegment(tx, orgId, at.data.encounterId, retryOf ?? segmentId)),
        )
        // El número que usó el modelo es la posición en la lista que se le dio.
        const target = (index: number) => ready.list[index]?.id
        // Lo ya confirmado no se corrige por voz: si lo intentó, se avisa con la frase en vez de perderlo.
        const onConfirmed = extracted.corrections.filter((item) => item.index >= ready.pendingCount)
        const saved = await withOrgContext(deps.db, orgId, async (tx) => {
          const result = await saveDictationSegment(tx, orgId, userId, at.data.id, at.data.encounterId, {
            drafts: extracted.drafts,
            corrections: extracted.corrections.flatMap((item) => {
              const suggestionId = item.index < ready.pendingCount ? target(item.index) : undefined
              return suggestionId ? [{ suggestionId, changes: item.changes, said: item.sourceText }] : []
            }),
            removals: extracted.removals.flatMap((item) => {
              const suggestionId = target(item.index)
              return suggestionId ? [{ suggestionId, said: item.sourceText }] : []
            }),
            segmentId,
            // Lo que comprobó Clío: el tramo, con el final del anterior delante si sigue su frase.
            transcript: extracted.heard,
            // Y lo anterior que leyó: un diagnóstico no contradice lo dicho ahí («presenta fístula»).
            context: ready.context,
            formQuestions: ready.forms,
          })
          // El tramo queda ordenado, con lo que no se usó y por qué: se ve igual al volver a la atención.
          // Una frase reintentada sale de «No lo usé» de su tramo, o vuelve con lo que se sabe ahora.
          const left = unusedOf(extracted, onConfirmed, result.droppedForms)
          // Si el reintento no dejó nada ni devolvió la frase, sigue en «No lo usé» con su motivo de antes.
          const used = result.suggestions.length + result.corrected.length + (result.added?.length ?? 0) + result.removed.length > 0
          if (retryOf) await settleDictationRetry(tx, orgId, at.data.encounterId, retryOf, transcript, left, used)
          else if (!result.repeated) await settleDictationSegment(tx, orgId, at.data.encounterId, segmentId, left)
          return result
        })
        // Los fragmentos de este tramo que dieron lugar a algo: la pantalla los resalta en su respaldo.
        // Lo de una ficha solo si quedó como propuesta, y por dato (`formSources`): lo que el servidor
        // no dejó pasar no dio nada (QA del 14 nov, D20; revisión final del 15 nov, U5).
        const dropped = new Set(saved.droppedForms.map((item) => item.said))
        const sources = [...extracted.drafts.filter((item) => item.kind !== "ficha"), ...extracted.corrections, ...extracted.removals]
          .map((item) => item.sourceText ?? "")
          .filter(Boolean)
          .concat(saved.formSources)
        // Lo que el asistente no pudo usar de este tramo, con la frase si se sabe, para avisarle al odontólogo en vez de perderlo en silencio.
        const outside = extracted.outOfPlace ?? []
        const unused = [
          ...new Set([
            ...extracted.unused,
            ...outside.map((item) => item.said),
            ...onConfirmed.map((item) => item.sourceText).filter((said): said is string => !!said),
            ...dropped,
          ]),
        ]
        // Por qué no se usó, cuando se sabe: lo de una ficha lo dice el servidor; lo de un familiar o un peso dicho, su motivo.
        const unusedWhy = Object.fromEntries([
          ...outside.flatMap((item) => (DICTATION_OUT_OF_PLACE[item.why] ? [[item.said, DICTATION_OUT_OF_PLACE[item.why]] as const] : [])),
          ...saved.droppedForms.map((item) => [item.said, item.why] as const),
        ])
        // La pregunta de la ficha que nombra cada frase: «Usar en Percusión» la abre con la frase al lado.
        const unusedFor = Object.fromEntries(saved.droppedForms.filter((item) => item.targets.length).map((item) => [item.said, item.targets]))
        return { ...saved, sources, omitted: extracted.omitted + outside.length + onConfirmed.length + saved.droppedForms.length, unused, unusedWhy, unusedFor, model: extracted.model }
      })
    } catch (error) {
      if (isProviderConfigError(error)) return modelProblemResponse(c, deps, orgId, error, "asistente")
      throw error
    }
  })

  /**
   * El repaso al terminar el dictado (mesa del 20 nov 2026, P4): una lectura de toda la conversación
   * guardada con lo que ya quedó de ella. Completa lo que las pausas dejaron (cuándo vuelve, lo de su
   * salud, las respuestas de una ficha abierta) y parte cada tramo en turnos con quién habló. Solo
   * llama al modelo si hay tramos que ningún repaso leyó; lo que propone se guarda como lo de una
   * pausa, y nada entra a la historia sin confirmar. Se mide como el dictado.
   */
  app.post(`${base}/review`, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = params.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    const parsed = reviewInput.safeParse((await c.req.json().catch(() => null)) ?? {})
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const idle = { reviewed: false, suggestions: [], added: [], corrected: [], alreadyOnFile: [], alreadyDone: [], turnsSaved: [], turnsRejected: [], unused: [], model: null }
    try {
      return await runService(c, 200, async () => {
        const ready = await withOrgContext(deps.db, orgId, (tx) => startDictationReview(tx, orgId, userId, at.data.id, at.data.encounterId, { openForms: parsed.data.openForms ?? [] }))
        // Otro repaso ya lee lo nuevo: este no lo paga otra vez; la pantalla vuelve a mirar al rato.
        if (!ready.due) return ready.inProgress ? { ...idle, inProgress: true } : idle
        const reviewed = await releasingOnError(
          async () => {
            await withOrgContext(deps.db, orgId, (tx) => assertClioCanListen(tx, orgId, at.data.encounterId))
            return meterAiUse(
              deps.db,
              orgId,
              "dictado",
              () =>
                reviewDictation(
                  deps.db,
                  { secretsKey: deps.secretsKey, platform: deps.llm },
                  {
                    orgId,
                    segments: ready.segments,
                    earlierLeftOut: ready.earlierLeftOut,
                    pending: ready.pending,
                    confirmed: ready.confirmed,
                    discarded: ready.discarded,
                    forms: ready.forms,
                  },
                ),
              { encounterId: at.data.encounterId },
            )
          },
          () => withOrgContext(deps.db, orgId, (tx) => releaseDictationReview(tx, orgId, at.data.encounterId, ready.readIds)),
        )
        const segmentOf = (number: number) => ready.segments.find((segment) => segment.number === number)?.segmentId
        const saved = await withOrgContext(deps.db, orgId, (tx) =>
          saveDictationReview(tx, orgId, userId, at.data.id, at.data.encounterId, {
            reviewId: ready.reviewId,
            segments: ready.segments,
            readIds: ready.readIds,
            drafts: reviewed.drafts,
            turns: reviewed.turns.flatMap((item) => {
              const segmentId = segmentOf(item.number)
              return segmentId ? [{ segmentId, turns: item.turns }] : []
            }),
            unused: reviewed.unused,
            omitted: reviewed.omitted,
            outOfPlace: reviewed.outOfPlace,
            formQuestions: ready.forms,
          }),
        )
        return {
          reviewed: true,
          suggestions: saved.suggestions,
          added: saved.added,
          corrected: saved.corrected,
          alreadyOnFile: saved.alreadyOnFile,
          alreadyDone: saved.alreadyDone,
          turnsSaved: saved.turnsSaved,
          // Los que Clío no devolvió tal cual, al leerlos o al guardarlos.
          turnsRejected: [...new Set([...reviewed.turnsRejected.flatMap((number) => segmentOf(number) ?? []), ...saved.turnsRejected])],
          unused: saved.unused,
          model: reviewed.model,
        }
      })
    } catch (error) {
      if (isProviderConfigError(error)) return modelProblemResponse(c, deps, orgId, error, "asistente")
      throw error
    }
  })

  /**
   * «Quién habló» en un turno de lo que se dijo, con un toque. Escribe lo que se dijo de la atención
   * (`clinical.write`, el guardián de la ruta de pacientes) y solo en borrador, por quien la lleva.
   */
  app.patch(`${base}/said/:segmentId/turns/:turn`, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = turnParams.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    const parsed = turnInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => ({
      turns: await withOrgContext(deps.db, orgId, (tx) =>
        setDictationTurnSpeaker(tx, orgId, userId, at.data.id, at.data.encounterId, at.data.segmentId, at.data.turn, parsed.data),
      ),
    }))
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
    // Sin cuerpo, como siempre; una respuesta de ficha manda el valor que se veía (409 si Clío lo cambió).
    const parsed = confirmInput.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        confirmDictationSuggestion(tx, orgId, userId, at.data.id, at.data.encounterId, at.data.suggestionId, parsed.data),
      ),
    )
  })

  /**
   * «Lo revisé con…» de lo que dijo de su salud en la consulta (mesa del 20 nov 2026): queda como su
   * declaración hecha en la consulta y entra a Antecedentes. Escribe en la historia (`clinical.write`,
   * el guardián de la ruta de pacientes); la confirmación de siempre no la lleva.
   */
  app.post(`${base}/:suggestionId/confirm-health`, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = suggestionParams.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    const parsed = healthReviewInput.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        confirmDictationHealth(tx, orgId, userId, at.data.id, at.data.encounterId, at.data.suggestionId, parsed.data),
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

  /**
   * Lo ya confirmado que se pidió quitar en voz alta: «Quitar del plan» lo hace con
   * la operación de siempre; «Dejarla» descarta el pedido. Nada se quita solo.
   */
  app.post(`${base}/:suggestionId/undo-confirmed`, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = suggestionParams.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => undoConfirmedDictation(tx, orgId, userId, at.data.id, at.data.encounterId, at.data.suggestionId)),
    )
  })

  app.post(`${base}/:suggestionId/keep`, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = suggestionParams.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => keepConfirmedDictation(tx, orgId, userId, at.data.id, at.data.encounterId, at.data.suggestionId)),
    )
  })

  /** «Deshacer» de la × en la ficha: la respuesta descartada a mano vuelve a como estaba. */
  app.post(`${base}/:suggestionId/restore`, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = suggestionParams.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        restoreDictationSuggestion(tx, orgId, userId, at.data.id, at.data.encounterId, at.data.suggestionId),
      ),
    )
  })

  app.post(`${base}/:suggestionId/discard`, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = suggestionParams.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    // La opción que eligió la persona entre las que Clío dudaba: queda la constancia.
    const body = discardInput.safeParse((await c.req.json().catch(() => null)) ?? {})
    if (!body.success) return validationError(c, body.error.issues)
    return runService(c, 200, async () => {
      await withOrgContext(deps.db, orgId, (tx) =>
        discardDictationSuggestion(tx, orgId, userId, at.data.id, at.data.encounterId, at.data.suggestionId, body.data.chosen),
      )
      return { ok: true }
    })
  })

  /** «Emitir receta» de la receta dictada: una receta con todos sus medicamentos (issue 109, fase 2). */
  app.post(`${base}/prescription`, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = params.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    return runService(c, 201, async () => {
      const issued = await withOrgContext(deps.db, orgId, (tx) =>
        issueDictationPrescription(tx, orgId, userId, at.data.id, at.data.encounterId),
      )
      await keepIssuedPaper({
        run: (fn) => withOrgContext(deps.db, orgId, fn),
        storage: deps.storage,
        orgId,
        patientId: at.data.id,
        type: "prescription",
        documentId: issued.prescriptionId,
      })
      return issued
    })
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

  /**
   * El descanso médico dictado se emitió con el formulario de siempre (latidIA, issue 229): su
   * sugerencia queda con ese descanso.
   */
  app.post(`${base}/medical-leave/settle`, async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const at = params.safeParse(c.req.param())
    if (!at.success) return validationError(c, at.error.issues)
    const parsed = z.object({ medicalLeaveId: z.uuid() }).strict().safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => settleDictationMedicalLeave(tx, orgId, userId, at.data.id, at.data.encounterId, parsed.data.medicalLeaveId)),
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
