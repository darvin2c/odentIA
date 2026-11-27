import { type Db, withOrgContext } from "@odentia/db"
import { DICTATION_CHARS, type DictationFormQuestion, formNetMisses, getDictationCatalog, getOrgLocale, productHooksFor, ServiceError } from "@odentia/services"
import {
  askDictationModel,
  askDictationReview,
  type DictationExtraction,
  type DictationPending,
  type DictationReviewExtraction,
  type DictationReviewSegment,
  rereadFormSentences,
  reviewHeard,
} from "./dictation.js"
import { createConfiguredChatModel, resolveLlmSpec } from "./llm.js"
import { dictationProfileFor } from "./products.js"
import type { AgentRuntime } from "./run.js"

/**
 * Ordena un dictado en sugerencias, con el prompt y el esquema del producto de
 * la clínica (`dictationProfileFor`). Lee la configuración y el tarifario de la
 * clínica; no escribe nada. El texto del dictado viaja al proveedor del modelo
 * con la cuenta de odentIA.
 */
export async function extractDictation(
  db: Db,
  deps: Pick<AgentRuntime, "platform" | "secretsKey" | "createModel">,
  input: {
    orgId: string
    transcript: string
    /** Lo último que ya se ordenó de este dictado: ayuda a entender lo nuevo y no se registra otra vez. */
    context?: string | undefined
    /** Sugerencias de este dictado que el profesional aún no decide, para corregirlas o quitarlas por voz. */
    pending?: DictationPending[] | undefined
    /** Lo que una persona descartó en este dictado: si se vuelve a indicar, es nuevo (`DictationAsk.discarded`). */
    discarded?: readonly string[] | undefined
    /** Las preguntas vacías de las fichas empezadas en la atención (`dictationFormQuestions`). */
    forms?: readonly DictationFormQuestion[] | undefined
    /** Lo que ya proponen las sugerencias de ficha pendientes, por pregunta (`pendingFormValues`). */
    formPending?: ReadonlyMap<number, unknown> | undefined
  },
): Promise<DictationExtraction> {
  const transcript = input.transcript.trim()
  if (transcript.length < 3)
    throw new ServiceError("VALIDATION", 400, "Dicta o escribe algo para ordenar")
  if (transcript.length > DICTATION_CHARS) {
    throw new ServiceError(
      "VALIDATION",
      400,
      `El dictado admite hasta ${DICTATION_CHARS} caracteres por vez; termina y sigue con otro`,
    )
  }
  const { spec, product, services, diagnosisSystem, catalog, zone } = await withOrgContext(
    db,
    input.orgId,
    async (tx) => {
      const found = await getDictationCatalog(tx, input.orgId)
      return {
        spec: resolveLlmSpec(deps.platform),
        product: found.product,
        services: found.services.map((service) => service.name),
        diagnosisSystem: found.diagnosisSystem,
        catalog: found.catalog,
        zone: await getOrgLocale(tx, input.orgId),
      }
    },
  )
  const profile = dictationProfileFor(product)
  if (!profile)
    throw new ServiceError(
      "CLINICAL_ASSISTANT_UNAVAILABLE",
      409,
      "Clío aún no dicta en esta clínica",
    )
  const now = new Date()
  const pending = (input.pending ?? []).slice(0, 40)
  if (spec.provider === "fake" && !deps.createModel)
    return {
      ...profile.demoSegment(transcript, services, now, pending, diagnosisSystem.key),
      model: spec.modelName,
      // El doble de demostración no lee la frase que corta la pausa.
      heard: transcript,
    }

  const model = deps.createModel
    ? await deps.createModel(spec)
    : await createConfiguredChatModel(spec, { explicitCache: true, ...(profile.reasoning ? { reasoning: profile.reasoning } : {}) })
  const { read, heard } = await askDictationModel(
    model,
    spec,
    {
      provider: spec.provider,
      services,
      diagnosisList: diagnosisSystem.title,
      catalog,
      zone,
      now,
      transcript,
      context: input.context ?? "",
      pending,
      discarded: (input.discarded ?? []).slice(0, 20),
      forms: input.forms ?? [],
    },
    profile,
  )
  if (!read) {
    // El proveedor respondió, pero no con algo que se pueda ordenar: no se inventa nada.
    throw new ServiceError(
      "DICTATION_UNREADABLE",
      502,
      "El asistente no pudo ordenar ese dictado. Vuelve a intentarlo o regístralo a mano.",
    )
  }
  // La segunda lectura de las fichas: lo que la red avisaría se lee una vez más, en la misma pausa.
  // La red mira lo mismo que se comprobó: con el final del tramo anterior si lo nuevo sigue su frase.
  const forms = input.forms ?? []
  const misses = forms.length ? formNetMisses(read.drafts, forms, productHooksFor(product).site, heard, input.formPending) : []
  if (!misses.length) return { ...read, model: spec.modelName, heard }
  // Si esa lectura falla, la pausa no se pierde: queda lo de la primera y el aviso de la red.
  const reread = await rereadFormSentences(model, spec, misses, forms).catch(() => [])
  return { ...read, drafts: [...read.drafts, ...reread], model: spec.modelName, heard }
}

/**
 * El repaso al terminar el dictado (mesa del 20 nov 2026, P4): una llamada con toda la
 * conversación de la atención (los tramos que el servicio eligió, con su largo acotado) y lo que ya
 * quedó de ella. Devuelve lo que faltó, los turnos y lo que no tiene dónde ir; no escribe nada.
 */
export async function reviewDictation(
  db: Db,
  deps: Pick<AgentRuntime, "platform" | "secretsKey" | "createModel">,
  input: {
    orgId: string
    segments: readonly DictationReviewSegment[]
    earlierLeftOut: boolean
    /** Lo que ya quedó, como se le nombra a Clío: pendiente, confirmado y descartado. */
    pending: readonly string[]
    confirmed: readonly string[]
    discarded: readonly string[]
    forms?: readonly DictationFormQuestion[] | undefined
  },
): Promise<DictationReviewExtraction> {
  const { spec, product, services, diagnosisSystem, catalog, zone } = await withOrgContext(db, input.orgId, async (tx) => {
    const found = await getDictationCatalog(tx, input.orgId)
    return {
      spec: resolveLlmSpec(deps.platform),
      product: found.product,
      services: found.services.map((service) => service.name),
      diagnosisSystem: found.diagnosisSystem,
      catalog: found.catalog,
      zone: await getOrgLocale(tx, input.orgId),
    }
  })
  const profile = dictationProfileFor(product)
  if (!profile) throw new ServiceError("CLINICAL_ASSISTANT_UNAVAILABLE", 409, "Clío aún no dicta en esta clínica")
  const now = new Date()
  const forms = input.forms ?? []
  const heard = reviewHeard(input.segments)
  if (spec.provider === "fake" && !deps.createModel) {
    // El doble de demostración: lo que ordenaría de todo junto y cada tramo como un solo turno sin saber de quién.
    const demo = profile.demoSegment(heard, services, now, [], diagnosisSystem.key)
    const turns = input.segments.filter((segment) => segment.needsTurns).map((segment) => ({ number: segment.number, turns: [{ quien: "no_se_sabe" as const, texto: segment.transcript }] }))
    return { drafts: demo.drafts, omitted: 0, unused: [], outOfPlace: [], turns, turnsRejected: [], model: spec.modelName, heard }
  }
  const model = deps.createModel
    ? await deps.createModel(spec)
    : await createConfiguredChatModel(spec, { explicitCache: true, ...(profile.reasoning ? { reasoning: profile.reasoning } : {}) })
  const { read } = await askDictationReview(
    model,
    spec,
    {
      provider: spec.provider,
      services,
      diagnosisList: diagnosisSystem.title,
      catalog,
      zone,
      now,
      segments: input.segments,
      earlierLeftOut: input.earlierLeftOut,
      pending: input.pending,
      confirmed: input.confirmed,
      discarded: input.discarded,
      forms,
    },
    profile,
  )
  if (!read) {
    throw new ServiceError("DICTATION_UNREADABLE", 502, "Clío no pudo repasar la conversación. Lo que ya ordenó sigue igual.")
  }
  return { ...read, model: spec.modelName, heard }
}
