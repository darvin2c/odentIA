import type { Db } from "@odentia/db"
import { reportModelOutage } from "@odentia/services"
import { DecisionError, type DecisionModel } from "./port.js"

/**
 * Sin la clave de plataforma, o con la clave rechazada, el modelo de decisión
 * no sirve y ningún reintento lo arregla. La corrida sigue sin él (nunca se
 * corta ni deriva), pero lo ajeno ya no sale con el texto fijo y se cobra:
 * odentIA tiene que enterarse (ADR 0047). Un fallo pasajero (plazo, caída del
 * proveedor, respuesta con otra forma) no avisa: la siguiente llamada puede
 * funcionar.
 */
export interface DecisionKeyProblem {
  /** `DECISION_KEY_MISSING`: falta la clave; `DECISION_REJECTED`: el proveedor la rechazó. */
  code: "DECISION_KEY_MISSING" | "DECISION_REJECTED"
  /** Detalle técnico para Soporte: nunca lleva la clave ni lo que escribió la persona. */
  detail: string
}

export function decisionKeyProblem(error: unknown): DecisionKeyProblem | null {
  if (!(error instanceof DecisionError) || error.code !== "CONFIG") return null
  // Sin estado HTTP no hubo llamada: lo lanzó `createDecisionModel` al no encontrar la clave.
  return error.status === undefined
    ? { code: "DECISION_KEY_MISSING", detail: error.message }
    : { code: "DECISION_REJECTED", detail: error.message }
}

/** El mismo modelo, que anota cuando el proveedor rechaza la llamada por su configuración. */
export function watchDecisionKey(model: DecisionModel, onProblem: (problem: DecisionKeyProblem) => void): DecisionModel {
  return {
    ...model,
    async decide(state, questions, opts) {
      try {
        return await model.decide(state, questions, opts)
      } catch (error) {
        const problem = decisionKeyProblem(error)
        if (problem) onProblem(problem)
        throw error
      }
    },
  }
}

const DECISION_LABEL: Record<string, string> = {
  jev: "Jev (modelo de decisión)",
  baseline: "Línea base (modelo de decisión)",
}

/** Una vez por hora y proceso basta: el caso de Soporte ya junta las clínicas y no repite ninguna. */
const REPORT_EVERY_MS = 60 * 60_000
const lastReported = new Map<string, number>()

/**
 * Abre o suma la clínica al caso automático «Modelo sin responder» de Soporte,
 * el mismo del modelo que escribe (`reportModelOutage`), con su propio motivo:
 * proveedor de decisión y clase de problema. La clínica no recibe aviso: no
 * puede arreglarlo y su agente sigue respondiendo.
 */
export async function reportDecisionOutage(
  ownerDb: Db,
  input: { orgId: string; provider: string; problem: DecisionKeyProblem; at: Date },
): Promise<void> {
  const key = `${input.orgId}:${input.provider}:${input.problem.code}`
  const last = lastReported.get(key)
  if (last !== undefined && input.at.getTime() - last < REPORT_EVERY_MS) return
  lastReported.set(key, input.at.getTime())
  await reportModelOutage(ownerDb, {
    orgId: input.orgId,
    llm: input.provider,
    llmLabel: DECISION_LABEL[input.provider] ?? input.provider,
    code: input.problem.code,
    detail: input.problem.detail,
    at: input.at,
  })
}
