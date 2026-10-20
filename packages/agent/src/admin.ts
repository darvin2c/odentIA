import { type Db, withOrgContext } from "@odentia/db"
import { type AdminDecider, getAgentConfig, type RuleConflictModel, type TickDeps } from "@odentia/services"
import { meterAiUse } from "./ai-usage.js"
import { createDecisionModel, DecisionError, type DecisionModel, type DecisionQuestion, type PlatformDecisions } from "./decision/index.js"
import { type PlatformLlm, resolveLlmSpec } from "./llm.js"

/**
 * El modelo de Argos (el agente administrador). Solo decide entre opciones cerradas: de qué
 * línea habla un pedido y qué se quiere hacer con ella, y si una persona ya
 * avisó algo antes de que Sofi le escriba. No redacta, no pone cifras y
 * no ejecuta nada: eso sigue en los servicios.
 */
export interface AdminModelDeps {
  secretsKey: Buffer
  platform: PlatformLlm
  decisions?: PlatformDecisions
}

/**
 * Modelo de decisión de la organización para Argos: el que tenga
 * configurado y, si no eligió ninguno (o la plataforma no tiene su clave), su
 * modelo de chat respondiendo preguntas cerradas. Null con el modelo de
 * demostración: quien llama usa entonces su doble determinista.
 */
export async function createAdminDecisionModel(db: Db, deps: AdminModelDeps, orgId: string): Promise<DecisionModel | null> {
  const { provider, spec } = await withOrgContext(db, orgId, async (tx) => {
    const cfg = await getAgentConfig(tx, orgId)
    return { provider: cfg.decisionProvider, spec: resolveLlmSpec(deps.platform) }
  })
  if (spec.provider === "fake") return null
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
            ? { id: answer.id, kind: "choice", choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities }
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

/** Por encima de esto se da por dicho; por debajo, Sofi escribe como siempre. */
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
 * «¿Ya avisó algo?»: antes de que Sofi escriba por un seguimiento, lee lo
 * último que la persona escribió. Una llamada por mensaje, y solo cuando la
 * persona escribió hace poco. Si el modelo no está o falla, lanza: el servicio
 * escribe como siempre.
 */
export function createAlreadyTold(db: Db, deps: AdminModelDeps): NonNullable<TickDeps["alreadyTold"]> {
  return (orgId, input) =>
    meterAiUse(db, orgId, "ya_aviso", async () => {
      const model = await createAdminDecisionModel(db, deps, orgId)
      if (!model) return false
      const result = await model.decide(alreadyToldState(input), [ALREADY_TOLD_QUESTION])
      const answer = result.answers.find((item) => item.id === "ya_aviso")
      return answer?.kind === "yesno" && answer.probability >= ALREADY_TOLD_MIN
    })
}

/* ---------- «Lo que el agente debe saber»: ¿se contradicen? ---------- */

/** Por encima de esto se avisa que la regla nueva choca con otra. */
export const RULE_CONFLICT_MIN = 0.7

export const RULE_CONFLICT_QUESTION: DecisionQuestion = {
  id: "regla_contradice",
  kind: "yesno",
  instructions:
    "¿Estas dos indicaciones para el asistente de una clínica se contradicen, es decir, no se pueden cumplir las dos a la vez en algún caso?",
  criteria: {
    yes: "Cumplir una obliga a no cumplir la otra en algún caso (por ejemplo, una prohíbe algo que la otra permite u ofrece).",
    no: "Se pueden cumplir las dos a la vez: hablan de cosas distintas o una solo precisa a la otra.",
  },
}

/** Lo que viaja al modelo: solo los dos textos de las reglas, nada de pacientes. */
export function ruleConflictState(candidate: string, existing: string): string {
  return `Indicación nueva: ${candidate.slice(0, 600)}\nIndicación que ya tiene: ${existing.slice(0, 600)}`
}

/**
 * El modelo de decisión de la clínica, preguntado por dos reglas. Solo si la
 * clínica lo configuró (decisión 24): sin él, los servicios usan la
 * comparación simple (`simpleRulesConflict`). Null también con el modelo de
 * demostración.
 */
export async function createRuleConflictModel(db: Db, deps: AdminModelDeps, orgId: string): Promise<RuleConflictModel | null> {
  const provider = await withOrgContext(db, orgId, async (tx) => (await getAgentConfig(tx, orgId)).decisionProvider)
  if (provider === "none") return null
  const model = await createAdminDecisionModel(db, deps, orgId)
  if (!model) return null
  return (candidate, existing) =>
    meterAiUse(db, orgId, "administrador", async () => {
      const result = await model.decide(ruleConflictState(candidate, existing), [RULE_CONFLICT_QUESTION])
      const answer = result.answers.find((item) => item.id === RULE_CONFLICT_QUESTION.id)
      return answer?.kind === "yesno" && answer.probability >= RULE_CONFLICT_MIN
    })
}
