import { type Db, withOrgContext } from "@odentia/db"
import { message } from "@odentia/db/schema/crm"
import { recordAgentDecision } from "@odentia/services"
import { and, desc, eq, lt } from "drizzle-orm"
import { BURST_HORIZON_MS, BURST_MESSAGES, TRIAGE_QUESTIONS, TRIAGE_VERSION, triageOutcome, triageState } from "./points.js"
import { DecisionError, type DecisionModel, type DecisionResult } from "./port.js"
import { type AgentRoute, guardBurst, readRoute, ROUTE_QUESTIONS, ROUTE_VERSION, routeOutcome } from "./route.js"

/**
 * Estado mínimo que ve el modelo de decisión: el mensaje disparador, los que
 * el contacto envió seguidos antes de él y aún no tienen respuesta (la misma
 * ráfaga que atiende la corrida) y hasta dos anteriores suyos. Lo que escribió
 * la clínica puede llevar nombre o datos de la cita y no sale al proveedor.
 */
async function decisionState(
  db: Db,
  orgId: string,
  input: { conversationId: string; triggerMessageId: string },
): Promise<{ text: string; messages: number } | null> {
  return withOrgContext(db, orgId, async (tx) => {
    const [trigger] = await tx
      .select({ body: message.body, createdAt: message.createdAt })
      .from(message)
      .where(and(eq(message.id, input.triggerMessageId), eq(message.organizationId, orgId)))
      .limit(1)
    if (!trigger) return null
    // La ráfaga empieza después de lo último que salió de la clínica y nunca
    // llega más atrás que el horizonte: lo antiguo sin responder es historial.
    const [lastOut] = await tx
      .select({ createdAt: message.createdAt })
      .from(message)
      .where(
        and(
          eq(message.conversationId, input.conversationId),
          eq(message.direction, "out"),
          lt(message.createdAt, trigger.createdAt),
        ),
      )
      .orderBy(desc(message.createdAt))
      .limit(1)
    const horizon = trigger.createdAt.getTime() - BURST_HORIZON_MS
    const since = Math.max(horizon, lastOut?.createdAt.getTime() ?? 0)
    const earlier = (
      await tx
        .select({ body: message.body, createdAt: message.createdAt })
        .from(message)
        .where(
          and(
            eq(message.conversationId, input.conversationId),
            eq(message.direction, "in"),
            lt(message.createdAt, trigger.createdAt),
          ),
        )
        .orderBy(desc(message.createdAt), desc(message.id))
        .limit(BURST_MESSAGES + 1)
    ).reverse()
    const burst = earlier.filter((m) => m.createdAt.getTime() > since).slice(-(BURST_MESSAGES - 1))
    const previous = earlier.filter((m) => m.createdAt.getTime() <= since).slice(-2)
    return {
      text: triageState(
        previous.map((m) => ({ direction: "in" as const, body: m.body })),
        trigger.body ?? "[attachment]",
        burst.map((m) => m.body),
      ),
      // Cuántos mensajes seguidos sin respuesta leyó el modelo, contando el último.
      messages: burst.length + 1,
    }
  })
}

/**
 * Elige el camino del turno antes de llamar al modelo que escribe y lo deja en
 * el libro de decisiones (modo `route`). Nunca lanza: si el modelo de decisión
 * falla o no hay mensaje, devuelve null y el turno sigue por el camino abierto.
 */
export async function decideRoute(
  db: Db,
  orgId: string,
  decision: DecisionModel,
  input: { conversationId: string; triggerMessageId: string },
): Promise<AgentRoute | null> {
  const record = (extra: Parameters<typeof recordAgentDecision>[2]) =>
    withOrgContext(db, orgId, (tx) => recordAgentDecision(tx, orgId, extra)).then(
      () => undefined,
      () => undefined,
    )
  try {
    const read = await decisionState(db, orgId, input)
    if (read === null) return null
    const state = read.text
    const base = { ...input, point: ROUTE_VERSION, mode: "route" as const, provider: decision.provider, state }
    let result: DecisionResult
    try {
      result = await decision.decide(state, ROUTE_QUESTIONS)
    } catch (error) {
      const detail = error instanceof DecisionError ? `${error.code}: ${error.message}` : "fallo inesperado del modelo de decisión"
      await record({ ...base, answers: [], error: detail })
      return null
    }
    // En el libro queda el camino que de verdad se aplicó.
    const route = guardBurst(readRoute(result), read.messages)
    await record({
      ...base,
      model: result.model,
      answers: result.answers,
      outcome: routeOutcome(route),
      latencyMs: result.latencyMs,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
    })
    return route
  } catch {
    return null
  }
}

/**
 * Modo sombra: tras la corrida, el modelo de decisión responde el triaje del
 * mensaje disparador y el resultado solo se registra. Ningún fallo aquí
 * afecta al turno; un error del proveedor queda como fila con `error`.
 */
export async function runShadowTriage(
  db: Db,
  orgId: string,
  decision: DecisionModel,
  input: { conversationId: string; triggerMessageId: string },
): Promise<void> {
  const read = await decisionState(db, orgId, input)
  if (read === null) return
  const state = read.text
  const base = { conversationId: input.conversationId, triggerMessageId: input.triggerMessageId, point: TRIAGE_VERSION, provider: decision.provider, state }
  let result: DecisionResult
  try {
    result = await decision.decide(state, TRIAGE_QUESTIONS)
  } catch (error) {
    const detail = error instanceof DecisionError ? `${error.code}: ${error.message}` : "fallo inesperado del modelo de decisión"
    await withOrgContext(db, orgId, (tx) => recordAgentDecision(tx, orgId, { ...base, answers: [], error: detail }))
    return
  }
  await withOrgContext(db, orgId, (tx) =>
    recordAgentDecision(tx, orgId, {
      ...base,
      model: result.model,
      answers: result.answers,
      outcome: triageOutcome(result),
      latencyMs: result.latencyMs,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
    }),
  )
}

/** Registra que el modelo de decisión no pudo construirse (sin credenciales de plataforma). */
export async function recordShadowUnavailable(
  db: Db,
  orgId: string,
  provider: string,
  input: { conversationId: string; triggerMessageId: string },
  error: unknown,
): Promise<void> {
  const detail = error instanceof DecisionError ? `${error.code}: ${error.message}` : "no se pudo preparar el modelo de decisión"
  await withOrgContext(db, orgId, (tx) =>
    recordAgentDecision(tx, orgId, { ...input, point: TRIAGE_VERSION, provider, state: "", answers: [], error: detail }),
  )
}
