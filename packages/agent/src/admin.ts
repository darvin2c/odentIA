import { type Db, withOrgContext } from "@odentia/db"
import { type AdminDecider, getAgentConfig, type TickDeps } from "@odentia/services"
import { createDecisionModel, DecisionError, type DecisionModel, type DecisionQuestion, type PlatformDecisions } from "./decision/index.js"
import type { PlatformLlm } from "./llm.js"
import { resolveOrgLlm } from "./run.js"

/**
 * El modelo del Administrador. Solo decide entre opciones cerradas: de qué
 * línea habla un pedido y qué se quiere hacer con ella, y si una persona ya
 * avisó algo antes de que Recepción le escriba. No redacta, no pone cifras y
 * no ejecuta nada: eso sigue en los servicios.
 */
export interface AdminModelDeps {
  secretsKey: Buffer
  platform: PlatformLlm
  decisions?: PlatformDecisions
}

/**
 * Modelo de decisión de la organización para el Administrador: el que tenga
 * configurado y, si no eligió ninguno (o la plataforma no tiene su clave), su
 * modelo de chat respondiendo preguntas cerradas. Null con el modelo de
 * demostración: quien llama usa entonces su doble determinista.
 */
export async function createAdminDecisionModel(db: Db, deps: AdminModelDeps, orgId: string): Promise<DecisionModel | null> {
  const { provider, spec } = await withOrgContext(db, orgId, async (tx) => {
    const cfg = await getAgentConfig(tx, orgId)
    return { provider: cfg.decisionProvider, spec: await resolveOrgLlm(tx, orgId, cfg, deps) }
  })
  if (spec.source === "fake") return null
  const platform = deps.decisions ?? {}
  if (provider === "none" || provider === "baseline") return createDecisionModel("baseline", platform, spec)
  try {
    return await createDecisionModel(provider, platform, spec)
  } catch (error) {
    if (error instanceof DecisionError && error.code === "CONFIG") return createDecisionModel("baseline", platform, spec)
    throw error
  }
}

/** El modelo de decisión, visto como lo espera el intérprete de pedidos de los servicios. */
export function asAdminDecider(model: DecisionModel): AdminDecider {
  return {
    async decide(state, questions) {
      const result = await model.decide(state, questions)
      return {
        answers: result.answers.map((answer) =>
          answer.kind === "choice"
            ? { id: answer.id, kind: "choice", choice: answer.choice, confidence: answer.confidence }
            : answer.kind === "yesno"
              ? { id: answer.id, kind: "yesno", probability: answer.probability }
              : { id: answer.id, kind: answer.kind },
        ),
        model: result.model,
        usage: result.usage,
      }
    },
  }
}

/** Por encima de esto se da por dicho; por debajo, Recepción escribe como siempre. */
export const ALREADY_TOLD_MIN = 0.8

/** Lo que se le muestra al modelo: por qué se le va a escribir y lo último que la persona dijo. */
export function alreadyToldState(input: { reason: string; messages: string[] }): string {
  return [
    `La clínica está por escribirle a esta persona por este asunto: ${input.reason}.`,
    "Lo último que la persona le escribió a la clínica, de lo más reciente a lo más antiguo:",
    ...input.messages.map((text) => `- ${text.slice(0, 400)}`),
  ].join("\n")
}

export const ALREADY_TOLD_QUESTION: DecisionQuestion = {
  id: "ya_aviso",
  kind: "yesno",
  instructions:
    "¿Alguno de esos mensajes trata de ese mismo asunto (su cita, su presupuesto o su tratamiento)? Por ejemplo: avisa que no irá o no pudo ir, pide otra fecha, pregunta por el precio o la forma de pago, o dice qué decidió.",
  criteria: {
    yes: "Al menos un mensaje trata de ese asunto: la conversación sobre eso ya empezó y escribirle ahora la ignoraría.",
    no: "Ningún mensaje trata de ese asunto: son saludos o preguntas de otra cosa.",
  },
}

/**
 * «¿Ya avisó algo?»: antes de que Recepción escriba por un seguimiento, lee lo
 * último que la persona escribió. Una llamada por mensaje, y solo cuando la
 * persona escribió hace poco. Si el modelo no está o falla, lanza: el servicio
 * escribe como siempre.
 */
export function createAlreadyTold(db: Db, deps: AdminModelDeps): NonNullable<TickDeps["alreadyTold"]> {
  return async (orgId, input) => {
    const model = await createAdminDecisionModel(db, deps, orgId)
    if (!model) return false
    const result = await model.decide(alreadyToldState(input), [ALREADY_TOLD_QUESTION])
    const answer = result.answers.find((item) => item.id === "ya_aviso")
    return answer?.kind === "yesno" && answer.probability >= ALREADY_TOLD_MIN
  }
}
