import {
  type AgentModelStatus,
  createModelChecker,
  describeProviderProblem,
  llmModelName,
  meterAiUse,
  type ModelChecker,
  type ModelCheckResult,
  type PlatformLlm,
} from "@odentia/agent"
import type { Db } from "@odentia/db"
import { AGENT_MODEL_LABEL, type AgentModelCheck, reportModelOutage } from "@odentia/services"
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

async function reportFailed(deps: AgentModelDeps, orgId: string, result: ModelCheckResult): Promise<void> {
  if (!result.problem) return
  // El detalle técnico va al registro y a Soporte; nunca a la pantalla.
  console.error(`agente: el modelo ${result.model} no responde (${result.problem.code}: ${result.problem.detail})`)
  if (!deps.ownerDb) return
  await reportModelOutage(deps.ownerDb, {
    orgId,
    llm: result.model,
    llmLabel: AGENT_MODEL_LABEL,
    code: result.problem.code,
    detail: result.problem.detail,
    at: new Date(result.checkedAt),
  }).catch((error: unknown) => {
    console.error(`agente: caso «Modelo sin responder» sin abrir (${error instanceof Error ? error.message : String(error)})`)
  })
}

/** «Volver a comprobar» llama al modelo como mucho una vez por minuto y clínica; antes, responde lo guardado. */
export const FRESH_MODEL_CHECK_GAP_MS = 60_000

// Cuándo pidió cada clínica su última comprobación nueva, por comprobador (por proceso).
const freshAt = new WeakMap<ModelChecker, Map<string, number>>()

/** Si esta clínica puede pedir una comprobación nueva ahora; si puede, la anota. */
export function takeFreshModelCheck(checker: ModelChecker, orgId: string, now = Date.now()): boolean {
  let byOrg = freshAt.get(checker)
  if (!byOrg) {
    byOrg = new Map()
    freshAt.set(checker, byOrg)
  }
  const last = byOrg.get(orgId)
  if (last !== undefined && now - last < FRESH_MODEL_CHECK_GAP_MS) return false
  for (const [key, at] of byOrg) if (now - at >= FRESH_MODEL_CHECK_GAP_MS) byOrg.delete(key)
  byOrg.set(orgId, now)
  return true
}

/** Si el modelo responde: lo que dibuja el cajón y la fila de Integraciones. */
export async function checkOrgModel(deps: AgentModelDeps, orgId: string, options: { fresh?: boolean; now?: number } = {}): Promise<AgentModelStatus> {
  const checker = modelCheckerOf(deps)
  // Cada comprobación nueva se paga con la cuenta de odentIA: una por minuto y clínica.
  const fresh = !!options.fresh && takeFreshModelCheck(checker, orgId, options.now)
  // La llamada mínima se paga: se anota con su origen (ADR 0031). Lo guardado no llama a nadie.
  const result = await meterAiUse(deps.db, orgId, "comprobacion", () => checker.check({ fresh }))
  await reportFailed(deps, orgId, result)
  return { responds: result.responds, checkedAt: result.checkedAt }
}

/** La comprobación que reciben los servicios (encender, resumen). */
export function orgModelCheck(deps: AgentModelDeps, orgId: string): AgentModelCheck {
  return async () => {
    const result = await meterAiUse(deps.db, orgId, "comprobacion", () => modelCheckerOf(deps).check())
    await reportFailed(deps, orgId, result)
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
  if (problem.code !== "DAILY_LIMIT") {
    await reportFailed(deps, orgId, {
      model: llmModelName(deps.llm),
      responds: false,
      problem: { code: problem.code, detail: problem.detail },
      checkedAt: new Date().toISOString(),
    })
  }
  const message =
    who === "agente"
      ? "Sofi no puede responder ahora: el modelo no está disponible. Ya avisamos a odentIA."
      : "El asistente no puede usar el modelo ahora. Ya avisamos a odentIA."
  return c.json(errorBody(c, "LLM_CONFIG", message), 409)
}
