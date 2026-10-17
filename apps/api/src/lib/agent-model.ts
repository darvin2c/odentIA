import {
  type AgentModelStatus,
  checkAgentModels,
  createModelChecker,
  describeProviderProblem,
  meterAiUse,
  type ModelChecker,
  type ModelCheckResult,
  type PlatformLlm,
} from "@odentia/agent"
import { type Db, withOrgContext } from "@odentia/db"
import { AGENT_LLMS, type AgentLlm, type AgentModelCheck, getAgentConfig, reportModelOutage } from "@odentia/services"
import type { Context } from "hono"
import { errorBody } from "./error.js"

/**
 * «El modelo responde» en la API (fase 4, tablero 3): una sola comprobación
 * para encender Recepción, el resumen del agente e Integraciones. Lo que no
 * responde se avisa a odentIA con el caso automático de Soporte; la clínica
 * nunca ve el motivo técnico.
 */
export interface AgentModelDeps {
  db: Db
  llm: PlatformLlm
  /** Rol owner: abre el caso «Modelo sin responder». Sin él, solo queda en el registro. */
  ownerDb?: Db
  /** Sustituye el comprobador (pruebas con un doble). */
  modelChecker?: ModelChecker
}

// Las cuentas son de la plataforma: un comprobador (y su caché de 10 minutos) por cuentas.
const checkers = new WeakMap<PlatformLlm, ModelChecker>()

export function modelCheckerOf(deps: AgentModelDeps): ModelChecker {
  if (deps.modelChecker) return deps.modelChecker
  let checker = checkers.get(deps.llm)
  if (!checker) {
    checker = createModelChecker(deps.llm)
    checkers.set(deps.llm, checker)
  }
  return checker
}

const labelOf = (llm: AgentLlm) => AGENT_LLMS.find((option) => option.id === llm)?.label ?? llm

async function reportFailed(deps: AgentModelDeps, orgId: string, failed: ModelCheckResult[]): Promise<void> {
  for (const result of failed) {
    if (!result.problem) continue
    // El detalle técnico va al registro y a Soporte; nunca a la pantalla.
    console.error(`agente: el modelo ${result.llm} no responde (${result.problem.code}: ${result.problem.detail})`)
    if (!deps.ownerDb) continue
    await reportModelOutage(deps.ownerDb, {
      orgId,
      llm: result.llm,
      llmLabel: labelOf(result.llm),
      code: result.problem.code,
      detail: result.problem.detail,
      at: new Date(result.checkedAt),
    }).catch((error: unknown) => {
      console.error(`agente: caso «Modelo sin responder» sin abrir (${error instanceof Error ? error.message : String(error)})`)
    })
  }
}

/** El modelo elegido y, si no responde, el otro: lo que dibuja el cajón y la fila de Integraciones. */
export async function checkOrgModel(
  deps: AgentModelDeps,
  orgId: string,
  llm: AgentLlm,
  options: { fresh?: boolean } = {},
): Promise<AgentModelStatus> {
  const checker = modelCheckerOf(deps)
  // La llamada mínima se paga: se anota con su origen (ADR 0031). Lo guardado no llama a nadie.
  const { status, failed } = await meterAiUse(deps.db, orgId, "comprobacion", () => checkAgentModels(checker, llm, options))
  await reportFailed(deps, orgId, failed)
  return status
}

/** La comprobación que reciben los servicios (encender, resumen). */
export function orgModelCheck(deps: AgentModelDeps, orgId: string): AgentModelCheck {
  return async (llm) => {
    const result = await meterAiUse(deps.db, orgId, "comprobacion", () => modelCheckerOf(deps).check(llm))
    if (!result.responds) await reportFailed(deps, orgId, [result])
    return { responds: result.responds, checkedAt: result.checkedAt }
  }
}

/**
 * El modelo falló en una prueba («Probar», simulación, dictado de práctica):
 * la pantalla dice qué pasa sin nombrar claves ni variables, y odentIA
 * recibe el caso con el motivo técnico.
 */
export async function modelProblemResponse(c: Context, deps: AgentModelDeps, orgId: string, error: unknown, who: "agente" | "asistente") {
  const problem = describeProviderProblem(error)
  const { llm } = await withOrgContext(deps.db, orgId, (tx) => getAgentConfig(tx, orgId)).catch(() => ({ llm: null }))
  if (llm && problem.code !== "DAILY_LIMIT") {
    await reportFailed(deps, orgId, [
      { llm, responds: false, problem: { code: problem.code, detail: problem.detail }, checkedAt: new Date().toISOString() },
    ])
  }
  const message =
    who === "agente"
      ? "El agente no puede responder ahora: el modelo no está disponible. Ya avisamos a odentIA."
      : "El asistente no puede usar el modelo ahora. Ya avisamos a odentIA."
  return c.json(errorBody(c, "LLM_CONFIG", message), 409)
}
