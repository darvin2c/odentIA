import { type Db, withOrgContext } from "@odentia/db"
import { DICTATION_CHARS, getDictationCatalog, getOrgLocale, ServiceError } from "@odentia/services"
import { askDictationModel, type DictationExtraction, type DictationPending } from "./dictation.js"
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
    }

  const model = deps.createModel
    ? await deps.createModel(spec)
    : await createConfiguredChatModel(spec, { explicitCache: true, ...(profile.reasoning ? { reasoning: profile.reasoning } : {}) })
  const { read } = await askDictationModel(
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
  return { ...read, model: spec.modelName }
}
