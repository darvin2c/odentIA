import { type Db, withOrgContext } from "@odentia/db"
import {
  asksPriceOrAvailability,
  identifyAskedService,
  listAgentServices,
  noteServiceInterest,
  recordAgentDecision,
  type ServiceInterestOutcome,
} from "@odentia/services"
import { DecisionError, type DecisionModel, type DecisionQuestion } from "./decision/port.js"

/**
 * Quién anota el interés cuando alguien pregunta por un servicio (decisión 15
 * de la fase 4, versión 2). Tres pasos, ninguno en manos del modelo que
 * escribe:
 * 1. El buscador identifica el servicio concreto (`identifyAskedService`); si
 *    no hay uno, no se anota nada.
 * 2. El modelo de decisión de la clínica, si tiene uno, responde una sola
 *    pregunta de sí o no sobre ese servicio. No se le pide elegir entre todos
 *    los servicios: los modelos de decisión tienden a la primera opción y se
 *    confunden con listas largas. Sin modelo de decisión vale una regla
 *    simple: preguntó el precio o la disponibilidad.
 * 3. El sistema crea o actualiza la oportunidad (`noteServiceInterest`).
 */
export const INTEREST_VERSION = "interest.v1"
/** Desde aquí el sí es «de alta probabilidad». Punto de partida, por medir. */
export const INTEREST_MIN = 0.7

/**
 * «¿Esta persona muestra interés en hacerse este tratamiento, ella o alguien
 * de su familia?». Instrucciones en inglés, como el resto de las preguntas a
 * los proveedores; el estado va en español.
 */
export const INTEREST_QUESTION: DecisionQuestion = {
  id: "interest",
  kind: "yesno",
  instructions:
    "Does this person show interest in getting this treatment, for themselves or for someone in their family?",
  criteria: {
    yes: "They ask its price, when it can be done or how it works, or say they want it or need it, for themselves or a relative.",
    no: "They only collect prices for others (another clinic, a list of all prices), ask about something else, or the treatment is not what they are asking about.",
  },
}

/** Lo que viaja al modelo de decisión: lo que escribió la persona y el nombre del servicio. Nada de la ficha. */
export function interestState(said: string, serviceName: string): string {
  return `Contact (latest): ${said.slice(0, 1000)}\nTreatment: ${serviceName}`
}

export interface AskedInterestInput {
  contactId: string
  conversationId: string
  triggerMessageId: string | null
  /** Lo que escribió la persona en esta ráfaga, junto. */
  said: string
  decision: DecisionModel | null
}

/**
 * Anota el interés de quien preguntó por un servicio concreto. Nunca corta la
 * corrida: un fallo del modelo de decisión equivale a no anotar nada.
 */
export async function noteAskedInterest(
  db: Db,
  orgId: string,
  input: AskedInterestInput,
): Promise<{
  outcome: ServiceInterestOutcome | "sin_servicio" | "sin_interes"
  serviceId: string | null
}> {
  const said = input.said.trim()
  if (!said) return { outcome: "sin_servicio", serviceId: null }
  const service = identifyAskedService(
    said,
    await withOrgContext(db, orgId, (tx) => listAgentServices(tx, orgId)),
  )
  if (!service) return { outcome: "sin_servicio", serviceId: null }
  let interested: boolean
  if (input.decision) {
    const state = interestState(said, service.name)
    const record = (fields: {
      answers: unknown[]
      error?: string
      outcome?: Record<string, unknown>
      model?: string
      latencyMs?: number
      inputTokens?: number | null
      outputTokens?: number | null
    }) =>
      withOrgContext(db, orgId, (tx) =>
        recordAgentDecision(tx, orgId, {
          conversationId: input.conversationId,
          triggerMessageId: input.triggerMessageId,
          point: INTEREST_VERSION,
          // Decide algo de la corrida (anotar o no): no es una sombra.
          mode: "route",
          provider: input.decision?.provider ?? "desconocido",
          state,
          ...fields,
        }),
      ).catch(() => undefined)
    try {
      const result = await input.decision.decide(state, [INTEREST_QUESTION])
      const answer = result.answers.find((item) => item.id === INTEREST_QUESTION.id)
      const probability = answer?.kind === "yesno" ? answer.probability : null
      interested = probability !== null && probability >= INTEREST_MIN
      await record({
        answers: result.answers,
        outcome: { serviceId: service.id, probability, noted: interested },
        model: result.model,
        latencyMs: result.latencyMs,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
      })
    } catch (error) {
      await record({
        answers: [],
        error:
          error instanceof DecisionError
            ? `${error.code}: ${error.message}`
            : "fallo inesperado del modelo de decisión",
      })
      return { outcome: "sin_interes", serviceId: service.id }
    }
  } else {
    interested = asksPriceOrAvailability(said)
  }
  if (!interested) return { outcome: "sin_interes", serviceId: service.id }
  const noted = await withOrgContext(db, orgId, (tx) =>
    noteServiceInterest(tx, orgId, {
      contactId: input.contactId,
      conversationId: input.conversationId,
      serviceId: service.id,
      said,
    }),
  )
  return { outcome: noted.outcome, serviceId: service.id }
}
